import { createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

export const NATIVE_HOST_NAME = "com.fabushi.chatgpt_computer_control";

export function browserExtensionHome() {
  return process.env.COMPUTER_BROWSER_EXTENSION_HOME
    || join(homedir(), ".chatgpt-computer-control", "browser-extension");
}

export function browserExtensionPaths() {
  const home = browserExtensionHome();
  const userKey = createHash("sha256").update(userInfo().username).digest("hex").slice(0, 12);
  return {
    home,
    extension: join(home, "extension"),
    secret: join(home, "native-host.secret"),
    socket: platform() === "win32"
      ? `\\\\.\\pipe\\chatgpt-computer-control-${userKey}`
      : join(home, "native-host.sock"),
    launcher: join(home, platform() === "win32" ? "native-host.cmd" : "native-host"),
    manifest: join(home, `${NATIVE_HOST_NAME}.json`),
    metadata: join(home, "install.json"),
  };
}
