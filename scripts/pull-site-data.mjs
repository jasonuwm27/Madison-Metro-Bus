/**
 * Pull a fresh site export from the VM to this machine.
 *
 *   node scripts/pull-site-data.mjs
 *   node scripts/pull-site-data.mjs --no-export   # reuse the VM's last export
 *
 * Re-runs the export on the VM, tars it, copies ONE file, and unpacks into
 * site/public/data.
 *
 * Why a tarball rather than `scp -r`: the export is 1,464 small files. Over
 * SSH each one costs a round trip, which on a home connection is minutes;
 * tarred it is a single 0.56 MB transfer that completes in seconds.
 *
 * Nothing here is secret -- the exported JSON is exactly what the public site
 * serves -- so this only needs the SSH key you already use for the VM.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const HOST = process.env.BUS_VM_HOST ?? "opc@163.192.9.150";
const KEY = process.env.BUS_VM_KEY ?? "C:\\bus-archive\\jasonssh.key";
const DEST = resolve(import.meta.dirname, "..", "site", "public", "data");
const skipExport = process.argv.includes("--no-export");

const ssh = (cmd) =>
  execFileSync("ssh", ["-i", KEY, "-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=accept-new", HOST, cmd], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).toString();

try {
  if (!skipExport) {
    console.log("  regenerating export on the VM…");
    const out = ssh(
      `cd /opt/bus/repo && sudo -u opc bash -c 'set -a; . ./.env; set +a; node --import tsx/esm scripts/export-site.ts --out=/tmp/sitedata' 2>&1 | tail -1`,
    );
    const line = out.trim().split("\n").pop() ?? "";
    try {
      const j = JSON.parse(line);
      console.log(`  export: ${j.stopFiles} stops, ${j.totalMegabytes} MB`);
    } catch {
      console.log(`  ${line.slice(0, 160)}`);
    }
  }

  console.log("  packing…");
  ssh("cd /tmp && rm -f sitedata.tgz && tar czf sitedata.tgz -C /tmp/sitedata .");

  console.log("  downloading…");
  const tmp = resolve(import.meta.dirname, "..", "sitedata.tgz");
  execFileSync("scp", ["-i", KEY, "-o", "ConnectTimeout=30", `${HOST}:/tmp/sitedata.tgz`, tmp], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Replace wholesale: a stop that drops out of the export must not linger
  // locally and serve numbers the current dataset no longer supports.
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  // --force-local: GNU tar parses a leading "C:" as host:path and tries to
  // reach a remote machine called "C". Without it, every Windows absolute path
  // fails with "Cannot connect to C: resolve failed".
  execFileSync("tar", ["--force-local", "-xzf", tmp, "-C", DEST], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  rmSync(tmp, { force: true });

  if (!existsSync(resolve(DEST, "index.json"))) throw new Error("index.json missing after unpack");
  console.log(`\n  Data ready in site/public/data`);
  console.log(`  Now run:  pnpm site      →  http://localhost:8788\n`);
} catch (error) {
  console.error("\n  Pull failed:", error instanceof Error ? error.message : String(error));
  console.error("  Check the VM is reachable and BUS_VM_KEY points at your SSH key.\n");
  process.exit(1);
}
