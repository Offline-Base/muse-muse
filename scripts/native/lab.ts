/**
 * Sets a lab box's token: a new one for the lane, with only its hash in native_labs (docs/NATIVE_LAB.md). The token is
 * written to a file only you can read, and it's never printed. Put it in Parameter Store, then delete the file:
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/native/lab.ts mac /secure/path/mac-token [instance-id]
 *   aws ssm put-parameter --region us-east-1 --name /musemuse/lab/mac/token --type SecureString --overwrite \
 *     --value file:///secure/path/mac-token
 *
 * Running it again replaces the token, and the box picks up the new one on its next 401.
 */
import { writeFileSync } from "node:fs";
import { hashLabToken, newLabToken } from "@/lib/native/lab-token";
import { setLabToken } from "@/lib/native/lab-box";
import { NATIVE_LANES, type NativeLane } from "@/lib/native/types";

const [lane, out, instanceId] = process.argv.slice(2);
if (!NATIVE_LANES.includes(lane as NativeLane) || !out) {
  console.error("Usage: scripts/native/lab.ts <mac|windows> <file for the token> [instance id]");
  process.exit(1);
}
const token = newLabToken();
// Written first: a token that reached the database and nowhere else could never be used.
writeFileSync(out, token, { mode: 0o600, flag: "wx" });
await setLabToken(lane as NativeLane, hashLabToken(token), instanceId ?? null);
console.log(`Set the ${lane} lab's token. It's in ${out}, readable only by you. Delete it once it's in Parameter Store.`);
process.exit(0);
