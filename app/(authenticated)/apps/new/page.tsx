import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadNewAppPage } from "@/lib/app-services/apps";
import { NewAppFlow } from "./new-app-flow";

export default async function NewAppPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string; project?: string; name?: string; image?: string; template?: string; source?: string }>;
}) {
  const { parent: preselectedParentId, project: preselectedProjectId, name: prefilledName, image: prefilledImage, template: prefilledTemplate, source: preselectedSource } = await searchParams;
  const actor = await currentActor();

  if (!actor) {
    redirect("/login");
  }

  const data = await pageData(loadNewAppPage(actor));

  return (
    <NewAppFlow
      orgId={actor.org.id}
      orgSlug={actor.org.slug}
      templates={data.templates}
      parentApps={data.parentApps}
      baseDomain={data.baseDomain}
      recentProjectId={data.recentProjectId}
      defaultParentId={preselectedParentId}
      defaultProjectId={preselectedProjectId}
      defaultName={prefilledName}
      defaultImage={prefilledImage}
      defaultTemplate={prefilledTemplate}
      defaultSource={preselectedSource}
      containerImportEnabled={data.containerImportEnabled}
    />
  );
}
