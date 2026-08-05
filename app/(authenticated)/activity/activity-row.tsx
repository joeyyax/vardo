"use client";

import { Fragment } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { detailsFor, phraseFor, subjectSummary } from "@/lib/activity/labels";
import { isFleetWide } from "@/lib/activity/group";
import type { ActivityGroup, ActivitySubjectRef } from "@/lib/activity/types";

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function SubjectName({ subject }: { subject: ActivitySubjectRef }) {
  if (!subject.app) return <span className="font-semibold">{subject.label}</span>;
  return (
    <Link
      href={`/apps/${subject.app.name}`}
      className="font-semibold hover:underline"
    >
      {subject.label}
    </Link>
  );
}

/** Fleet rows name the subjects rather than reducing them to a number. */
function Subjects({ subjects }: { subjects: ActivitySubjectRef[] }) {
  const labels = subjects.map((s) => s.label);
  const { shown, remainder } = subjectSummary(labels);

  return (
    <>
      {subjects.slice(0, shown.length).map((subject, index) => (
        <Fragment key={subject.id}>
          {index > 0 && (
            <span>
              {index === shown.length - 1 && remainder === 0 ? " and " : ", "}
            </span>
          )}
          <SubjectName subject={subject} />
        </Fragment>
      ))}
      {remainder > 0 && (
        <span className="text-muted-foreground">
          {" "}
          and {remainder} more
        </span>
      )}
    </>
  );
}

export function ActivityRow({ group }: { group: ActivityGroup }) {
  const phrase = phraseFor(group.action);
  const failed = group.outcome === "failure";
  const details = detailsFor(group);
  const fleet = isFleetWide(group);

  const actorName = group.actor?.name || group.actor?.email || "Vardo";
  const timeLabel =
    group.count > 1 && group.firstAt.getTime() !== group.lastAt.getTime()
      ? `${formatTime(group.firstAt)} – ${formatTime(group.lastAt)}`
      : formatTime(group.lastAt);

  return (
    <div
      className={`squircle flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
        failed
          ? "border border-status-error/25 bg-status-error-muted/50"
          : "hover:bg-muted/50"
      }`}
    >
      <Avatar size="sm" className="mt-0.5">
        {group.actor?.image && (
          <AvatarImage src={group.actor.image} alt={actorName} />
        )}
        <AvatarFallback>
          {group.actor
            ? getInitials(group.actor.name, group.actor.email)
            : "V"}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm leading-relaxed">
          {failed && (
            <AlertTriangle
              aria-hidden="true"
              className="mr-1 inline size-3.5 -translate-y-px text-status-error"
            />
          )}
          <span className="font-medium">{actorName}</span>{" "}
          <span>{phrase.text}</span>
          {!phrase.standalone && (
            <>
              {" "}
              <Subjects subjects={group.subjects} />
            </>
          )}
          {group.count > 1 && !fleet && (
            <span className="text-muted-foreground"> ×{group.count}</span>
          )}
          {details.length > 0 && (
            <span className="text-muted-foreground"> {details.join(" · ")}</span>
          )}
        </p>

        {failed && group.error && (
          <p className="squircle rounded bg-background-deep px-2 py-1 font-mono text-xs text-status-error">
            <span className="line-clamp-2 break-words">{group.error}</span>
          </p>
        )}

        {failed && group.errorVariants > 1 && (
          <p className="text-xs text-muted-foreground">
            {group.errorVariants} different errors in this run
          </p>
        )}
      </div>

      <time
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
        dateTime={group.lastAt.toISOString()}
        title={group.lastAt.toLocaleString()}
      >
        {timeLabel}
      </time>
    </div>
  );
}
