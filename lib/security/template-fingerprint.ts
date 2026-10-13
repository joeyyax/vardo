// After a scan, recognize which PROBE_TEMPLATES apply to the app by checking
// its image/compose content and fetching a few probing paths on the live host.

import { randomBytes } from "node:crypto";
import pLimit from "p-limit";
import { PROBE_TEMPLATES, type ProbeTemplate, type TemplateSignal } from "@/lib/probe-guard/templates";
import { assertPublicDomain } from "./validate-domain";
import { getDomainProbePolicy } from "./outbound-policy";
import { fetchProbe, type ProbeResponse } from "./file-exposure";

/** What a template needs from a live host: a baseline so SPAs don't match, plus per-path responses. */
export type TemplateObservation = {
  /** The home page response with full headers. */
  home: ProbeResponse | null;
  /** A random-path probe response; same as checkFileExposure uses to detect catch-alls. */
  baseline: ProbeResponse | null;
  /** Path → response for the paths the templates' signals ask for. Missing entries mean the fetch failed. */
  paths: Map<string, ProbeResponse | null>;
};

const IMAGE_LINE = /^\s*image:\s*["']?([^"'\s]+)["']?/gim;

/** Image names from compose `image:` lines, in source order. Empty strings are skipped. */
export function extractComposeImages(composeContent: string | null | undefined): string[] {
  if (!composeContent) return [];
  const out: string[] = [];
  for (const match of composeContent.matchAll(IMAGE_LINE)) {
    const value = match[1]?.trim();
    if (value) out.push(value);
  }
  return out;
}

function imagesMatchSignal(signal: TemplateSignal, imageName: string | null | undefined, childImages: readonly (string | null)[], composeImages: readonly string[]): boolean {
  if (!("image" in signal)) return false;
  const re = signal.image;
  if (imageName && re.test(imageName)) return true;
  for (const child of childImages) {
    if (child && re.test(child)) return true;
  }
  for (const image of composeImages) {
    if (re.test(image)) return true;
  }
  return false;
}

function cookieNames(headers: Headers): string[] {
  const names: string[] = [];
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() !== "set-cookie") continue;
    const cookie = value.split(";", 1)[0]?.split("=", 1)[0]?.trim();
    if (cookie) names.push(cookie);
  }
  return names;
}

function cookieMatches(signal: TemplateSignal, home: ProbeResponse | null): boolean {
  if (!("cookie" in signal) || !home) return false;
  return cookieNames(home.headers).includes(signal.cookie);
}

function headerMatches(signal: TemplateSignal, home: ProbeResponse | null): boolean {
  if (!("header" in signal) || !home) return false;
  const value = home.headers.get(signal.header);
  if (value == null) return false;
  if (!signal.value) return true;
  return signal.value.test(value);
}

/** Same status, media type, and body hash, or close enough in length. Matches the file-exposure baseline rule. */
function matchesBaseline(response: ProbeResponse, baseline: ProbeResponse): boolean {
  if (response.status !== baseline.status || response.contentType !== baseline.contentType) return false;
  if (response.hash === baseline.hash) return true;
  const tolerance = Math.max(64, Math.max(response.length, baseline.length) * 0.05);
  return Math.abs(response.length - baseline.length) <= tolerance;
}

function pathMatches(signal: TemplateSignal, response: ProbeResponse | null, baseline: ProbeResponse | null): boolean {
  if (!("path" in signal) || !response) return false;
  if (response.status < 200 || response.status > 299) return false;
  if (baseline && matchesBaseline(response, baseline)) return false;
  if (!signal.body) return true;
  return signal.body.test(response.text);
}

function matchesSignal(signal: TemplateSignal, observation: TemplateObservation, imageName: string | null | undefined, childImages: readonly (string | null)[], composeImages: readonly string[]): boolean {
  if ("image" in signal) return imagesMatchSignal(signal, imageName, childImages, composeImages);
  if ("cookie" in signal) return cookieMatches(signal, observation.home);
  if ("header" in signal) return headerMatches(signal, observation.home);
  return pathMatches(signal, observation.paths.get(signal.path) ?? null, observation.baseline);
}

/** True when any of `signals` matches the observation. Pure; safe to unit-test without network. */
export function matchSignals(signals: readonly TemplateSignal[], observation: TemplateObservation, imageName?: string | null, childImages?: readonly (string | null)[], composeImages?: readonly string[]): boolean {
  return signals.some((signal) => matchesSignal(signal, observation, imageName ?? null, childImages ?? [], composeImages ?? []));
}

/** What fingerprinting needs from the app under scan. */
export type FingerprintInput = {
  appId: string;
  /** The primary public domain; null skips the live fetches. */
  domain: string | null;
  imageName?: string | null;
  composeContent?: string | null;
  childImages?: readonly (string | null)[];
  /** Template ids the app already has, so the caller can record them as applied. */
  appliedTemplateIds: readonly string[];
};

/** What fingerprinting returns: the templates it recognized (a superset may already be applied). */
export type FingerprintResult = {
  recognizedIds: readonly string[];
};

/** Recognized template ids for every template that didn't already apply. Pure: caller fetches and persists. */
export async function fingerprintApp(input: FingerprintInput): Promise<FingerprintResult> {
  const templates = PROBE_TEMPLATES.filter((t) => !input.appliedTemplateIds.includes(t.id));
  const composeImages = extractComposeImages(input.composeContent);
  const childImages = input.childImages ?? [];

  // Every image-only signal is matched locally.
  const imageOnly = templates.filter((t) => t.detect.every((s) => "image" in s));
  const recognized = new Set(imageOnly.filter((t) => matchSignals(t.detect, { home: null, baseline: null, paths: new Map() }, input.imageName, childImages, composeImages)).map((t) => t.id));

  const templatesNeedingFetch = templates.filter((t) => !imageOnly.includes(t));
  if (templatesNeedingFetch.length === 0 || !input.domain) return { recognizedIds: [...recognized] };

  const observation = await gatherObservations(input.domain, templatesNeedingFetch);
  for (const template of templatesNeedingFetch) {
    if (matchSignals(template.detect, observation, input.imageName, childImages, composeImages)) recognized.add(template.id);
  }

  return { recognizedIds: [...recognized] };
}

/** Path strings the listed templates need, deduplicated. */
function neededPaths(templates: readonly ProbeTemplate[]): string[] {
  const out = new Set<string>();
  for (const t of templates) {
    for (const signal of t.detect) {
      if ("path" in signal) out.add(signal.path);
    }
  }
  return [...out];
}

/** Fetch the home page (with headers/cookies) and one path per template signal in parallel. */
export async function gatherObservations(domain: string, templates: readonly ProbeTemplate[]): Promise<TemplateObservation> {
  await assertPublicDomain(domain);
  const policy = await getDomainProbePolicy();
  const origin = `https://${domain}`;
  const limit = pLimit(5);

  const nonce = randomBytes(8).toString("hex");
  const paths = neededPaths(templates);

  const tasks: Array<() => Promise<unknown>> = [
    () => limit(() => fetchProbe(`${origin}/`, policy)),
    () => limit(() => fetchProbe(`${origin}/vardo-probe-${nonce}`, policy)),
  ];
  for (const path of paths) {
    tasks.push(() => limit(() => fetchProbe(`${origin}${path}`, policy)));
  }

  const results = await Promise.all(tasks.map((task) => task().catch(() => null)));
  const [home, baseline, ...pathResults] = results;

  const pathMap = new Map<string, ProbeResponse | null>();
  paths.forEach((path, i) => pathMap.set(path, (pathResults[i] as ProbeResponse | null) ?? null));

  return { home: home as ProbeResponse | null, baseline: baseline as ProbeResponse | null, paths: pathMap };
}