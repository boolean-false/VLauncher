import assert from "node:assert/strict";
import test from "node:test";
import {
  contentAddition,
  prepareContentAddition,
} from "../src/contentAddition.ts";
import type { LocalProfile } from "../src/model.ts";

test("beta installation pins the displayed release and preserves profile constraints", () => {
  const profile = {
    roots: ["kompot", "client"],
    root_requirements: { kompot: "=1.2.2", client: "=0.3.0" },
  };
  const request = contentAddition(profile, "client", {
    version: "0.4.0",
    channel: "beta",
  });
  assert.deepEqual(request, {
    roots: ["kompot", "client"],
    requirements: { kompot: "=1.2.2", client: "=0.4.0" },
    channels: ["stable", "beta"],
  });
  assert.equal(profile.root_requirements.client, "=0.3.0");
});

test("new profile and stable release do not opt into prereleases", () => {
  assert.deepEqual(
    contentAddition(undefined, "kompot", {
      version: "1.2.2",
      channel: "stable",
    }),
    {
      roots: ["kompot"],
      requirements: { kompot: "=1.2.2" },
      channels: ["stable"],
    },
  );
});

test("adding a stable pack retains the installed beta channel", async () => {
  const profile = {
    roots: ["client"],
    packages: [{ id: "client", version: "0.4.0", kind: "mod" }],
  } as LocalProfile;
  const request = await prepareContentAddition(
    profile,
    "kompot",
    { version: "1.2.2", channel: "stable" },
    async () => [
      { version: "0.4.0", channel: "beta" },
      { version: "0.5.0", channel: "alpha" },
    ],
  );
  assert.deepEqual(request.channels, ["stable", "beta"]);
  assert.deepEqual(request.roots, ["client", "kompot"]);
});
