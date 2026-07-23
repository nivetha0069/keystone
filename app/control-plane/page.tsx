import type { Metadata } from "next";
import { CmdbDashboard } from "../cmdb-dashboard";

export const metadata: Metadata = {
  title: "Keystone Control Plane",
  description:
    "Governed CMDB migration orchestration, approval, IRE execution and verification.",
};

export default function ControlPlanePage() {
  return <CmdbDashboard />;
}
