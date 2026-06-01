import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  serializeRoleTree,
  deserializeRoleTree,
  type RoleTreeContract,
} from "../src/role-tree.ts";
import { materializeUpstreamRoleRepo, loadRoleContractAtCommit } from "../src/role-repo.ts";
import {
  commitOnBranch,
  materializeCheckout,
  readCheckout,
  listRoleBranches,
} from "../src/role-checkout-repo.ts";

// #216 PR1 — the working-copy repo primitives. A role is a git branch; editing
// it like code means: materialize the branch tip into a desk working dir, edit
// files, read them back, and commit them onto the SAME branch (advancing it, not
// forking). These extract the file-walk already proven in commitTree /
// readTreeAtCommit, so the round-trip is byte-lossless against real git.

const ROLE_MD = `---
name: worker
description: edited in the checkout
persistent: false
effort: high
---

# generated body
`;

describe("role checkout repo primitives (#216 PR1)", () => {
  let dir: string;
  let checkout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clobber-checkout-repo-"));
    checkout = mkdtempSync(join(tmpdir(), "clobber-checkout-dir-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  it("materialize → edit → read → commitOnBranch advances the branch with the edit, others byte-equal", () => {
    const repo = materializeUpstreamRoleRepo(dir);
    const branch = repo.forks.get("worker")!.branch;
    const baseSha = repo.forks.get("worker")!.sha;
    const before = loadRoleContractAtCommit(dir, baseSha);

    materializeCheckout(dir, branch, checkout);

    // The codec layer-B file is on disk and editable like any file.
    const promptPath = join(checkout, "system-prompt.md");
    const original = readFileSync(promptPath, "utf8");
    writeFileSync(promptPath, `${original}\nEDIT: a new line in the working copy.\n`);
    // A ROLE.md sidecar lives at the root; it must NOT perturb the contract.
    writeFileSync(join(checkout, "ROLE.md"), ROLE_MD);

    const tree = readCheckout(checkout);
    const edited = deserializeRoleTree(tree);
    const pin = commitOnBranch(dir, branch, edited, "edit: working-copy change");

    // Branch advanced past the base.
    expect(pin.branch).toBe(branch);
    expect(pin.sha).not.toBe(baseSha);

    const after = loadRoleContractAtCommit(dir, pin.sha);
    expect(after.systemPrompt).toBe(`${before.systemPrompt}\nEDIT: a new line in the working copy.\n`);
    // Every other field is byte-identical — git reuses the parent's blobs.
    expect(after.framing).toBe(before.framing);
    expect(after.skills).toEqual(before.skills);
    expect(after.allowedTools).toEqual(before.allowedTools);
    expect(after.seedRefs).toEqual(before.seedRefs);
    expect(after.wakePrograms).toEqual(before.wakePrograms);
    expect(after.triggers).toEqual(before.triggers);
  });

  it("a ROLE.md sidecar in the tree is ignored by deserialize (regression invariant)", () => {
    const repo = materializeUpstreamRoleRepo(dir);
    const baseSha = repo.forks.get("worker")!.sha;
    const pre = loadRoleContractAtCommit(dir, baseSha);
    const tree = new Map(serializeRoleTree(pre));

    const withoutSidecar = deserializeRoleTree(tree);
    tree.set("ROLE.md", ROLE_MD);
    const withSidecar = deserializeRoleTree(tree);

    expect(withSidecar).toEqual(withoutSidecar);
    expect(withSidecar).toEqual(pre);
  });

  it("readCheckout reads back exactly what materializeCheckout wrote (round-trip)", () => {
    const repo = materializeUpstreamRoleRepo(dir);
    const branch = repo.forks.get("worker")!.branch;
    materializeCheckout(dir, branch, checkout);

    const tree = readCheckout(checkout);
    const back = deserializeRoleTree(tree);
    expect(back).toEqual(loadRoleContractAtCommit(dir, branch));
  });

  it("listRoleBranches lists the role branches in the repo", () => {
    const repo = materializeUpstreamRoleRepo(dir);
    const branches = listRoleBranches(dir);
    for (const [, fork] of repo.forks) {
      expect(branches).toContain(fork.branch);
    }
  });
});

// Belt-and-suspenders: the regression invariant must hold for a contract that
// carries no ROLE.md at all (a pre-#216 commit) — it deserializes unchanged.
describe("pre-ROLE.md commit deserializes unchanged (#216)", () => {
  it("a tree without ROLE.md is a valid contract", () => {
    const contract: RoleTreeContract = {
      framing: "f",
      systemPrompt: "s",
      skills: [],
      allowedTools: ["Read"],
      allowedCliCommands: ["status"],
      hooks: "{}",
      triggers: [],
      seedRefs: [],
      wakePrograms: [],
      defaultWakeProgram: null,
      habits: [],
    };
    const tree = serializeRoleTree(contract);
    expect(tree.has("ROLE.md")).toBe(false);
    expect(deserializeRoleTree(tree)).toEqual(contract);
  });
});
