import { Catalog } from "./Catalog";
import type { LocalProfile, RunTask } from "../model";
import type { SignedInstallPlan } from "../api";

// The profile uses the same catalog; only its target profile and quick actions differ.
export function ProfileContentPicker({
  profile,
  active,
  busy,
  running,
  run,
  preview,
  close,
  refreshProfiles,
}: {
  profile: LocalProfile;
  active: boolean;
  busy: boolean;
  running: boolean;
  run: RunTask;
  preview: (value: {
    profile: LocalProfile;
    plan: SignedInstallPlan;
    title: string;
  }) => void;
  close: () => void;
  refreshProfiles: () => Promise<void>;
}) {
  return (
    <Catalog
      active={active}
      profiles={[profile]}
      selected={profile.id}
      select={() => {}}
      busy={busy}
      running={new Set(running ? [profile.id] : [])}
      run={run}
      preview={preview}
      deepLink=""
      resetDetail={0}
      create={close}
      refreshProfiles={refreshProfiles}
      profileContext={{ close }}
    />
  );
}
