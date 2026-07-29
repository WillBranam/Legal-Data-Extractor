import { LegalWorkspace } from "@/components/legal-workspace";

export default function Home() {
  return <LegalWorkspace localMode={process.env.LOCAL_ONLY_MODE === "enabled"} />;
}
