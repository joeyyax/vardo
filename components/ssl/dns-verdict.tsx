import { Check, X } from "lucide-react";
import { TONE_TEXT, type Diagnosis, type DnsState } from "./domain-diagnosis";

/** The check or cross and label for a DNS diagnosis. */
export function DnsVerdict({ diagnosis }: { diagnosis: Diagnosis<DnsState> }) {
  const Icon = diagnosis.tone === "success" ? Check : X;
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Icon className={`size-3.5 ${TONE_TEXT[diagnosis.tone]}`} />
      <span className={`text-xs font-medium ${TONE_TEXT[diagnosis.tone]}`}>{diagnosis.label}</span>
    </div>
  );
}
