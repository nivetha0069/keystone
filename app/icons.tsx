export type IconName =
  | "grid" | "pulse" | "tool" | "shield" | "play" | "pause" | "search" | "arrow" | "check"
  | "database" | "spark" | "clock" | "graph" | "refresh" | "x" | "filter" | "chevron"
  | "bolt" | "users" | "award" | "alert" | "target" | "book" | "heart" | "upload" | "link" | "file" | "menu";

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    pulse: <path d="M3 12h4l2.2-6 4.1 12 2.1-6H21"/>,
    tool: <path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.6 7 6.3 4.7a4 4 0 0 0 5 5L4 17.4V20h2.6l7.7-7.7a4 4 0 0 0 5-5L17 9.6 13.6 6.2 16 4z"/>,
    shield: <path d="M12 3 20 6v5c0 5.2-3.4 8.7-8 10-4.6-1.3-8-4.8-8-10V6l8-3Z"/>,
    play: <path d="m9 7 8 5-8 5V7Z" fill="currentColor"/>,
    pause: <><path d="M9 7v10"/><path d="M15 7v10"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    spark: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z"/><path d="m18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    graph: <><circle cx="5" cy="16" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="19" cy="14" r="2"/><path d="m6.5 14.5 4-6.5M13.7 7.2l3.7 5.5M7 16h10"/></>,
    refresh: <><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5"/></>,
    x: <><path d="m7 7 10 10"/><path d="M17 7 7 17"/></>,
    filter: <path d="M4 6h16M7 12h10M10 18h4"/>,
    chevron: <path d="m9 7 5 5-5 5"/>,
    bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>,
    users: <><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.8 15.3c2.5.4 4.3 1.9 5 4.2"/></>,
    award: <><circle cx="12" cy="9" r="5"/><path d="m8.7 13.4-1.7 7 5-2.8 5 2.8-1.7-7"/></>,
    alert: <><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 10v4"/><path d="M12 16.8v.4"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8"/></>,
    book: <><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v17.5H7.5A2.5 2.5 0 0 0 5 22V4.5Z"/><path d="M19 16.5H7.5A2.5 2.5 0 0 0 5 19"/></>,
    heart: <path d="M12 20.3S4.8 15.8 2.9 11.4C1.7 8.5 3.6 5.3 6.8 5.3c2 0 3.5 1.2 5.2 3.3 1.7-2.1 3.2-3.3 5.2-3.3 3.2 0 5.1 3.2 3.9 6.1-1.9 4.4-9.1 8.9-9.1 8.9Z"/>,
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 14v5h14v-5"/></>,
    link: <><path d="M10 13a4 4 0 0 0 5.7.1l2.4-2.4a4 4 0 0 0-5.7-5.7L11 6.4"/><path d="M14 11a4 4 0 0 0-5.7-.1l-2.4 2.4a4 4 0 0 0 5.7 5.7l1.4-1.4"/></>,
    file: <><path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></>,
    menu: <><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
