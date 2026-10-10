import { SkeletonGroup } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

const BAR = "bg-muted animate-pulse motion-reduce:animate-none rounded-md";

export default function ProjectsLoading() {
  return (
    <SkeletonGroup className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className={`h-8 w-36 ${BAR}`} />
        <div className={`h-10 w-36 ${BAR}`} />
      </div>

      <div className="flex flex-wrap gap-x-10 gap-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className={`h-7 w-16 ${BAR}`} />
            <div className={`h-3.5 w-24 ${BAR}`} />
          </div>
        ))}
      </div>

      <div className={`h-9 w-full max-w-sm ${BAR}`} />

      <div className="space-y-5">
        {[4, 3].map((rows, group) => (
          <div key={group} className="space-y-2">
            <div className="flex items-center justify-between px-2 py-2">
              <div className={`h-5 w-32 ${BAR}`} />
              <div className={`h-4 w-48 ${BAR}`} />
            </div>
            <Card variant="surface" className="space-y-1 p-3">
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="flex h-9 items-center gap-3 px-2">
                  <div className={`size-3 rounded-full ${BAR}`} />
                  <div className={`h-4 w-40 ${BAR}`} />
                  <div className={`ml-auto h-4 w-16 ${BAR}`} />
                </div>
              ))}
            </Card>
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}
