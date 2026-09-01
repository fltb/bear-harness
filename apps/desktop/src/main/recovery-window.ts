import { BrowserWindow } from "electron";
import type { RecoveryAction, RecoveryPrompt } from "./recovery-controller.js";

const LABELS: Record<RecoveryAction, string> = {
	retry: "重试启动",
	repair_database: "修复数据库并重启",
	use_default_character: "切换到默认角色",
	restore_default_character: "恢复默认角色包",
	export_data: "保存当前数据",
	open_data_location: "打开数据位置",
	open_backup_location: "打开备份位置",
	safe_reset: "保存并清空",
	exit: "退出",
};

const htmlEscape = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

function recoveryHtml(productName: string, prompt: RecoveryPrompt): string {
	const buttons = prompt.actions
		.map(
			(action, index) =>
				`<a class="action ${index === 0 ? "primary" : ""}" href="bear-recovery://action/${action}">${htmlEscape(LABELS[action])}</a>`,
		)
		.join("");
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; navigate-to bear-recovery:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(productName)} 恢复</title><style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07171c;color:#e7f3f2}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(560px,calc(100vw - 48px));padding:34px;border:1px solid #25434a;border-radius:18px;background:#0d2228;box-shadow:0 24px 80px #0008}h1{font-size:24px;margin:0 0 12px}p{color:#b8cccf;line-height:1.65;margin:0 0 28px;white-space:pre-wrap}.actions{display:grid;gap:10px}.action{display:block;text-decoration:none;text-align:center;padding:12px 16px;border-radius:10px;border:1px solid #31535b;color:#dcebec;background:#132d34}.action:hover{background:#193a42}.primary{background:#2c807d;border-color:#48aaa4;color:white}.note{font-size:12px;color:#78979c;margin-top:20px}
</style></head><body><main class="card"><h1>${htmlEscape(productName)} 无法安全启动</h1><p>${htmlEscape(prompt.reason)}</p><div class="actions">${buttons}</div><div class="note">恢复工具不会修改对话内容，除非你明确选择“保存并清空”。</div></main></body></html>`;
}

/** A Host-independent recovery surface with no preload, Node access or product IPC. */
export function chooseRecoveryAction(
	productName: string,
	prompt: RecoveryPrompt,
): Promise<RecoveryAction | null> {
	return new Promise((resolve) => {
		let settled = false;
		const window = new BrowserWindow({
			width: 640,
			height: 620,
			minWidth: 480,
			minHeight: 480,
			show: false,
			title: `${productName} 恢复`,
			backgroundColor: "#07171c",
			autoHideMenuBar: true,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
			},
		});
		const finish = (action: RecoveryAction | null): void => {
			if (settled) return;
			settled = true;
			resolve(action);
			if (!window.isDestroyed()) window.close();
		};
		window.webContents.session.setPermissionCheckHandler(() => false);
		window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false),
		);
		window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		window.webContents.on("will-navigate", (event, url) => {
			event.preventDefault();
			try {
				const parsed = new URL(url);
				if (parsed.protocol !== "bear-recovery:") return;
				const action = parsed.pathname.replace(/^\//, "") as RecoveryAction;
				if (prompt.actions.includes(action)) finish(action);
			} catch {
				// Invalid navigation is ignored; the isolated recovery window remains available.
			}
		});
		window.once("closed", () => finish(null));
		window.once("ready-to-show", () => window.show());
		void window.loadURL(
			`data:text/html;charset=utf-8,${encodeURIComponent(recoveryHtml(productName, prompt))}`,
		);
	});
}
