import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CMDB Modernization Control Plane",
    template: "%s | CMDB Modernization Control Plane",
  },
  description: "Comprehend, prioritize, and remediate CMDB data through an IRE-governed pipeline.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
