const button = document.querySelector("#toggle");
const bridge = document.querySelector("#bridge");
const details = document.querySelector("#details");

function render(result) {
  if (result?.error) {
    button.textContent = result.error;
    button.disabled = true;
    return;
  }
  button.disabled = false;
  button.textContent = result.connected ? "本机服务已连接" : "重新连接本机服务";
  bridge.textContent = result.connected ? "本机控制服务：已连接" : "本机控制服务：未连接，请先运行安装与服务命令";
  details.textContent = `扩展 ID：${result.extensionId || "未知"}\n当前标签页：${result.eligible ? (result.claimed ? "已认领" : "可由控制服务选择") : "不可控制"}${result.nativeError ? `\n错误：${result.nativeError}` : ""}`;
}

button.addEventListener("click", () => chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(() => chrome.runtime.sendMessage({ type: "status" }, render), 300)));
chrome.runtime.sendMessage({ type: "status" }, render);
