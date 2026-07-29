// The one demo import source: AWS's public IP ranges feed.
//
//   https://ip-ranges.amazonaws.com/ip-ranges.json
//
// Demo mode uses the URL as the identity of the source but never fetches it.
// Instead, this format-true fixture is passed through the repository's real
// `aws-ip-ranges` adapter. The records are explicitly synthetic: every CIDR
// comes from the documentation-only TEST-NET ranges reserved by RFC 5737.
//
// Prefixes cycle through the eight services below. Every row is treated as a
// healthy, unique new network CI and processed in successive bounded packets.

export const DEMO_SOURCE_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
export const DEMO_SOURCE_NAME = "AWS IP Ranges schema fixture";
export const DEMO_RECORD_COUNT = 600;

export type DemoAwsPrefix = {
  ip_prefix: string;
  region: string;
  service: string;
  network_border_group: string;
};

export type DemoAwsSnapshot = {
  syncToken: string;
  createDate: string;
  prefixes: DemoAwsPrefix[];
};

export const DEMO_SERVICES = [
  "EC2",
  "S3",
  "CLOUDFRONT",
  "API_GATEWAY",
  "DYNAMODB",
  "ROUTE53_HEALTHCHECKS",
  "AMAZON",
  "GLOBALACCELERATOR",
] as const;

const REGIONS = [
  "us-east-1",
  "eu-west-1",
  "ap-southeast-2",
  "us-west-2",
  "eu-central-1",
  "ap-northeast-1",
];

const DOCUMENTATION_NETWORKS = ["192.0.2", "198.51.100", "203.0.113"] as const;

function documentationPrefix(index: number): string {
  const network = DOCUMENTATION_NETWORKS[Math.floor(index / 256)];
  return `${network}.${index % 256}/32`;
}

export const demoSourceSnapshot: DemoAwsSnapshot = {
  // A zero token prevents this generated fixture from being mistaken for a
  // captured AWS publication while retaining the official response shape.
  syncToken: "0",
  createDate: "2026-07-29-00-00-00",
  prefixes: Array.from({ length: DEMO_RECORD_COUNT }, (_unused, index) => {
    const service = DEMO_SERVICES[index % DEMO_SERVICES.length];
    const round = Math.floor(index / DEMO_SERVICES.length);
    const region = REGIONS[round % REGIONS.length];
    return {
      ip_prefix: documentationPrefix(index),
      region,
      service,
      network_border_group: region,
    } satisfies DemoAwsPrefix;
  }),
};
