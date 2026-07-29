// The one demo import source: AWS's public IP ranges feed.
//
//   https://ip-ranges.amazonaws.com/ip-ranges.json
//
// Demo mode always imports from this single URL, and always resolves it from
// the frozen snapshot below — the browser never actually fetches it. That is
// deliberate: a live fetch would reintroduce network flakiness, CORS, and a
// 1.5 MB payload into a mode whose whole promise is "cannot fail, touches
// nothing". The URL is the *identity* of the source; the snapshot is its data.
//
// The snapshot is format-true to the real feed ({ syncToken, createDate,
// prefixes[] }) so the repository's real `aws-ip-ranges` source adapter can
// transform it exactly as it would a live download. It is a frozen sample,
// not a current mirror — prefixes are real AWS-advertised ranges as of the
// capture date, trimmed to 48 entries so the demo stays readable on screen.
//
// Ordering is load-bearing: prefixes cycle through the eight services below in
// strict rotation, so `index % 8` in the fixture identifies the service. The
// EC2 cohort (index % 8 === 0) is the homogeneous group the bounded approval
// packet is built from.

export const DEMO_SOURCE_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
export const DEMO_SOURCE_NAME = "AWS IP Ranges";

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

/** Service rotation — position n of every round of eight is always service n. */
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

const REGIONS = ["us-east-1", "eu-west-1", "ap-southeast-2", "us-west-2", "eu-central-1", "ap-northeast-1"];

// Six rounds × eight services = 48 prefixes. Row r of a service's list is used
// in round r with REGIONS[r].
const SERVICE_PREFIXES: Record<(typeof DEMO_SERVICES)[number], string[]> = {
  EC2: ["3.80.0.0/12", "18.130.0.0/16", "13.236.0.0/14", "35.80.0.0/12", "18.184.0.0/15", "13.112.0.0/14"],
  S3: ["52.216.0.0/15", "52.218.0.0/17", "52.95.128.0/21", "52.92.16.0/20", "52.219.72.0/22", "52.219.136.0/22"],
  CLOUDFRONT: ["13.32.0.0/15", "54.230.0.0/16", "99.84.0.0/16", "13.35.0.0/16", "54.239.128.0/18", "204.246.164.0/22"],
  API_GATEWAY: ["3.216.135.0/24", "3.248.171.0/24", "13.210.1.64/26", "44.234.22.128/26", "3.124.243.128/25", "13.113.196.64/26"],
  DYNAMODB: ["52.94.0.0/22", "52.119.240.0/21", "3.218.180.0/24", "52.94.248.0/28", "52.119.224.0/20", "52.94.24.0/23"],
  ROUTE53_HEALTHCHECKS: ["15.177.0.0/18", "15.177.64.0/21", "205.251.192.0/21", "205.251.244.0/23", "15.177.72.0/21", "205.251.198.0/24"],
  AMAZON: ["52.46.0.0/18", "54.239.0.0/17", "72.21.192.0/19", "205.251.240.0/22", "54.240.0.0/18", "176.32.96.0/21"],
  GLOBALACCELERATOR: ["75.2.0.0/17", "99.83.64.0/21", "3.33.128.0/17", "15.197.0.0/17", "99.77.160.0/24", "75.2.128.0/17"],
};

const ROUNDS = 6;

export const demoSourceSnapshot: DemoAwsSnapshot = {
  // Real feeds carry an epoch-seconds syncToken; this one is the fixture's
  // frozen capture moment (2026-07-28T06:08:41Z), matching the fixture clock.
  syncToken: "1785218921",
  createDate: "2026-07-28-06-08-41",
  prefixes: Array.from({ length: ROUNDS * DEMO_SERVICES.length }, (_unused, index) => {
    const service = DEMO_SERVICES[index % DEMO_SERVICES.length];
    const round = Math.floor(index / DEMO_SERVICES.length);
    const region = REGIONS[round];
    return {
      ip_prefix: SERVICE_PREFIXES[service][round],
      region,
      service,
      network_border_group: region,
    } satisfies DemoAwsPrefix;
  }),
};
