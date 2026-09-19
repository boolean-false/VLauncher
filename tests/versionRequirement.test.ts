import assert from "node:assert/strict";
import test from "node:test";
import {
  makeVersionRequirement,
  isVersionRequirementValid,
  nextMinorVersion,
  normalizeVersion,
  normalizeVersionRequirement,
  parseVersionRequirement,
  versionRequirementExplanation,
} from "../src/versionRequirement.ts";

test("короткие версии VoxelCore дополняются до semver", () => {
  assert.equal(normalizeVersion("0.32"), "0.32.0");
  assert.equal(normalizeVersion("v1"), "1.0.0");
  assert.equal(normalizeVersion("0.32.1-beta.2"), "0.32.1-beta.2");
});

test("простые правила собираются без ручного ввода операторов", () => {
  assert.equal(makeVersionRequirement("minimum", "0.32"), ">=0.32.0");
  assert.equal(makeVersionRequirement("exact", "0.32"), "=0.32.0");
  assert.equal(makeVersionRequirement("range", "0.32", "0.33"), ">=0.32.0 <0.33.0");
  assert.equal(makeVersionRequirement("any"), "*");
  assert.equal(nextMinorVersion("0.32"), "0.33.0");
  assert.equal(normalizeVersionRequirement(">=0.32"), ">=0.32.0");
});

test("правило разбирается обратно для конструктора", () => {
  assert.deepEqual(parseVersionRequirement(">=0.32.0 <0.33.0"), {
    mode: "range",
    minimum: "0.32.0",
    maximum: "0.33.0",
  });
  assert.match(versionRequirementExplanation("*"), /любая версия/i);
  assert.equal(isVersionRequirementValid("^0.32"), true);
  assert.equal(isVersionRequirementValid(">=0.32 <0.34"), true);
  assert.equal(isVersionRequirementValid(">=0.32, <0.34"), false);
  assert.equal(isVersionRequirementValid("какая-нибудь версия"), false);
});
