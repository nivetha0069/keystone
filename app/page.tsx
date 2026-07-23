import { redirect } from "next/navigation";
import KeystoneLanding from "./components/KeystoneLanding";

export default async function Home(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await props.searchParams;
  const run = searchParams?.run;
  const runValue = Array.isArray(run) ? run[0] : run;
  if (runValue) {
    redirect(`/control-plane?run=${encodeURIComponent(runValue)}`);
  }
  return <KeystoneLanding />;
}
