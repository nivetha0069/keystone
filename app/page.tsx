import type { Metadata } from "next";
import { CmdbDashboard } from "./cmdb-dashboard";

export const metadata: Metadata = {
  title: "CMDB Modernization Control Plane",
  description:
    "Comprehend, prioritize, and remediate CMDB modernization runs with IRE-governed writeback.",
};

export default function Home() {
  return <CmdbDashboard />;
}
