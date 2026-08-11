import { LegalWorkspace } from "@/components/legal-workspace";

// Local-only mode is selected when the server starts. Keep this page dynamic so
// a public build cannot freeze browser-only mode into a later local session.
export const dynamic = "force-dynamic";

export default function Home() {
  return <LegalWorkspace localMode={process.env.LOCAL_ONLY_MODE === "enabled"} />;
}
