import assert from "node:assert/strict";
import test from "node:test";
import { friendlyError, technicalError } from "../src/model.ts";

test("compatibility errors name the package and retain diagnostic details", () => {
  const error = Object.assign(new Error("No compatible release"), {
    code: "no_compatible_release",
    details: { package: "client", requirements: ["=0.4.0"] },
  });
  assert.match(friendlyError(error), /«client»/);
  assert.match(friendlyError(error), /=0\.4\.0/);
  assert.match(friendlyError(error), /выберите другую версию/);
  assert.match(technicalError(error), /no_compatible_release/);
});

test("HTTP errors get actionable messages without matching version numbers", () => {
  assert.match(
    friendlyError(
      "Download request failed with status: 503 Service Unavailable",
    ),
    /временно недоступен/,
  );
  assert.equal(
    friendlyError("invalid package manifest: bad package 503"),
    "bad package 503",
  );
});
