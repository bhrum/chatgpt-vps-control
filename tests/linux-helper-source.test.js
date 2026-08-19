import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const helperPath = new URL("../native/linux/accessibility-helper.py", import.meta.url);

test("Linux application activation tolerates AT-SPI and X11 title formatting differences", async () => {
  const source = await readFile(helperPath, "utf8");
  assert.match(source, /wmctrl\s*=\s*shutil\.which\("wmctrl"\)/);
  assert.match(source, /re\.sub\(r"\[\^a-z0-9\]\+",\s*"",\s*\(matched_name or display_name\)\.lower\(\)\)/);
  assert.match(source, /windowactivate",\s*"--sync"/);
  assert.match(source, /candidate_window_ids/);
});
