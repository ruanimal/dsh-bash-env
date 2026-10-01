/**
 * dsh-bash-env — browser half.
 *
 * A dedicated **Settings → 终端环境** section, not a row inside General: the
 * executor's configuration is a page of its own (command budgets plus one group
 * per feature), and the general list is for preferences that fit one line.
 *
 * It registers into the shell's `settings.section` list slot — the same slot
 * General, Models, Plugins and Agent presets occupy — so it appears as a peer
 * section in the settings panel's own navigation, ordered between Models (10)
 * and Plugins (15).
 *
 * Every control edits a **top-level scalar** of the `bash-env` profile entry.
 * That is a hard constraint, not a preference: the settings form addresses
 * fields by a single-segment path inside the entry's namespace, so a nested
 * block could not be edited from here at all — which is why the host schema is
 * flat.
 *
 * The card is bound through `configForms` to the entry the Host actually
 * composes, so a deployment where the plugin is disabled shows no section, and a
 * save writes the same user layer the YAML does.
 */

window.__ModuleLoader__.load({
	id: "dsh-bash-env",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react_jsx_runtime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region locales
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.bashEnv";
		/** The PATH contract this page's fields compose, shown verbatim. */
		const ORDER_EXAMPLE = "<venv>/bin  :  额外 PATH 目录…  :  mise shims  :  继承的 PATH";
		/** English copy. */
		const en = {
			title: "Shell environment",
			description: "Resolve PATH, virtual environments and mise for every command from its working directory.",
			introTitle: "Why this exists",
			introLead: "dsh runs every command as a fresh, non-login, non-interactive `bash -c`: it reads no shell startup file, and the PATH it starts from is the one the process that launched dsh happened to have. A desktop launch usually misses ~/.cargo/bin, the mise shims, and any project interpreter — which is why a command that works in your terminal can be \"not found\" here.",
			introOrderLabel: "PATH is composed in this order",
			introOrder: "The virtual environment comes first on purpose. A version manager that also ships a python/python3 shim would otherwise win, and you would get VIRTUAL_ENV pointing at one environment while the interpreter comes from another — a failure with no error message at all.",
			introWhenLabel: "When a change applies",
			introWhen: "Saving applies to the next command; no restart. The environment is recomputed for every command from that command's own working directory, so switching projects switches the virtual environment.",
			introErrorsLabel: "When something is wrong",
			introErrors: "A mistyped option name fails the command and names the option, rather than being ignored: the executor stays mounted, so correcting the value restores the next command. A malformed line in the variable file reports its file and line number. Only a value of the wrong type can prevent the executor from loading at all.",
			introScope: "Scope: commands run through the bash tool. Other spawn paths — MCP servers, the terminal panel, processes a plugin starts itself — do not pass through this executor and keep the inherited environment.",
			introShellCardNote: "The built-in Terminal card no longer appears because this plugin takes over the executor; the command timeout and the output cap live here instead.",
			groupBudgets: "Command budgets",
			groupBudgetsNote: "The remaining budgets (working directory, the timeout ceiling, the spill cap and the kill grace period) are still set in the profile's YAML.",
			groupPath: "PATH and variables",
			groupVenv: "Python virtual environment",
			groupMise: "mise toolchains",
			timeoutMs: "Command timeout (ms)",
			timeoutMsHint: "How long one command may run before it is terminated.",
			timeoutMsHelp: "Default 120000. On expiry the process is asked to stop, then killed after the grace period; the result reports that it timed out rather than that it failed.",
			maxOutputBytes: "Output cap per stream (bytes)",
			maxOutputBytesHint: "How much of each stream is kept in memory.",
			maxOutputBytesHelp: "Default 64000. Output beyond this is not lost: it is written to a spill file whose path is reported with the result. This bounds the in-memory copy only.",
			prependPath: "Extra PATH directories",
			prependPathHint: "One directory per line, placed after the virtual environment and before the mise shims.",
			prependPathHelp: "A directory that does not exist yet is kept in place rather than dropped, so a version manager installed later starts working without another change. Duplicates are removed with the first occurrence keeping its position, so a nested shell cannot grow PATH.",
			envFile: "Environment file",
			envFileHint: "Absolute path to a file of KEY=VALUE lines, read before every command.",
			envFileHelp: "One KEY=VALUE per line; blank lines and # comments are ignored, and a leading \"export \" is accepted, so a line can be pasted from a shell startup file. Values expand $VAR and ${VAR} against the environment the command inherits, and can reference earlier lines; single quotes keep a value literal. The file is re-read on every command, so editing it applies at once. A configured file that cannot be read, or a line that is not KEY=VALUE, fails the command with the file and line number. The DSH_ prefix is refused: that namespace belongs to the harness.",
			envVars: "Inline variables",
			envVarsHint: "One KEY=VALUE per line, applied over the file's entries.",
			envVarsHelp: "Use this for a pair or two that belongs with the profile; use the file above for anything long or machine-specific. The same expansion and the same DSH_ restriction apply. A bad line invalidates the whole draft, so a save cannot write half the list and silently drop the rest.",
			bashEnv: "Shell startup file (BASH_ENV)",
			bashEnvHint: "Absolute path to a file bash sources before every command. Left empty, nothing is sourced.",
			bashEnvHelp: "This is the one thing variables cannot express: defining shell functions, setting shell options, or running a tool's own activation script. bash sources it for non-interactive shells — which is exactly what every command here is — and it is sourced after the environment above is assembled, so it has the last word on PATH. Two cautions: anything the file prints lands in every command's output, and options it sets (set -e, set -u) change what every command means. Keep it small, because it runs on every command and a nested shell runs it again. Aliases will not work: a non-interactive shell does not expand them. bash ignores an unreadable BASH_ENV in silence, so the plugin checks the file itself and fails the command with the reason instead.",
			venvEnabled: "Activate a virtual environment",
			venvEnabledHint: "Search the working directory and its parents, then export VIRTUAL_ENV.",
			venvEnabledHelp: "When off, nothing is searched and VIRTUAL_ENV is left exactly as inherited. When on, the search starts at the command's own working directory, so each project gets its own environment.",
			venvNames: "Directory names to look for",
			venvNamesHint: "Tried in this order at each level, one name per line.",
			venvNamesHelp: "Default: .venv then venv. A directory counts as an environment when it contains bin/python, which is what decides whether it can actually run anything.",
			venvMaxDepth: "Search depth",
			venvMaxDepthHint: "How many parent levels above the working directory to search.",
			venvMaxDepthHelp: "Default 3. 0 searches the working directory only. The bound exists so a workspace never picks up an environment that belongs to an unrelated project.",
			venvStopAt: "Never search this directory",
			venvStopAtHint: "The search does not enter this directory or anything above it.",
			venvStopAtHelp: "Defaults to your home directory, and that default is the point: without it a workspace anywhere under home would silently pick up ~/.venv for every project. A home-level environment has to be asked for explicitly, through the fallback below.",
			venvFallback: "Fallback environment",
			venvFallbackHint: "Used when the search finds nothing.",
			venvFallbackHelp: "Must contain bin/python to take effect; a path that does not is ignored rather than made to fail every command. This is where a home-level environment belongs, since the search never reaches it on its own.",
			miseEnabled: "Use mise shims",
			miseEnabledHint: "Put the shim directory on PATH so each tool resolves its version per directory.",
			miseEnabledHelp: "\"mise activate\" is an interactive-shell hook and cannot work here — it expects a long-lived shell that changes directory. The shim directory can: each shim resolves the tool version for the current directory when it is invoked, which is exactly what a fresh shell per command needs. Turning this off also stops the auto-install setting below from being applied.",
			miseShims: "Shim directory",
			miseShimsHint: "Placed after your extra directories and ahead of everything inherited.",
			miseShimsHelp: "Default ~/.local/share/mise/shims. An active virtual environment still comes first, so a project interpreter is never shadowed by a shim.",
			miseHookEnv: "Ask mise what this directory resolves to",
			miseHookEnvHint: "Run \`mise hook-env\` once per directory and apply its answer, instead of only putting shims on PATH.",
			miseHookEnvHelp: "Shims decide which executable runs; they cannot tell a build tool which JAVA_HOME to use, because that is a variable rather than a file. This asks mise for the whole answer — JAVA_HOME, GOROOT, GOBIN and any `[env]` section — once per directory, and reuses it until the mise configuration behind that directory changes, so the cost is paid once instead of per command. Two consequences worth knowing: a probe that fails (mise missing, slow, or exiting non-zero) falls back to the shims without failing the command, and which of the two happened is visible as DSH_MISE. Because a project's own `[env]` section is part of the answer, a file in a repository can set variables for every command run there — which is why this is off by default.",
			miseBin: "mise executable",
			miseBinHint: "Leave empty to use `mise` from PATH.",
			miseBinHelp: "Set an absolute path when mise is not on the PATH dsh was started with — the usual case for a desktop launch. Only consulted when the option above is on.",
			miseAutoInstall: "Let mise install on demand",
			miseAutoInstallHint: "Off injects MISE_AUTO_INSTALL=false.",
			miseAutoInstallHelp: "Leaving this off matters: when a project pins a tool version that is not installed, a plain `node -v` otherwise makes mise start a download and the command hangs until the timeout, with no output explaining why. With it off, installing is a deliberate act.",
			helpLabel: "Explain this option",
			failureStale: "This configuration had been changed elsewhere since the page loaded. Your edit was re-submitted at the current revision and is saved — nothing more to do.",
			failureReasonLabel: "The Host refused this write:",
			failureReasonEmpty: "no reason was reported",
			failureUnknown: "The Host did not accept these values. The two usual causes: the configuration was changed elsewhere since this page loaded (reopen Settings, then save again), or this plugin's host code has not been reloaded since it changed (restart the app).",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidBoolean: "Enter true or false.",
			invalidMap: "Each line must be KEY=VALUE with a valid name.",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default."
		};
		/** Simplified Chinese copy. */
		const zh = {
			title: "终端环境",
			description: "按每条命令自己的工作目录解析 PATH、虚拟环境与 mise。",
			introTitle: "为什么需要这个",
			introLead: "dsh 的每条命令都是一个全新的、非登录、非交互的 `bash -c`：它不读任何 shell 启动文件，而它的 PATH 来自启动 dsh 那个进程碰巧拥有的环境。从桌面图标启动时，这份 PATH 通常缺少 ~/.cargo/bin、mise shims，以及任何项目自己的解释器——于是终端里能跑的命令，在这里会「找不到」。",
			introOrderLabel: "PATH 按这个顺序合成",
			introOrder: "虚拟环境排在最前是刻意的。否则版本管理器自带的 python/python3 shim 会赢，你会得到 VIRTUAL_ENV 指向 A、而解释器来自 B 的状态——一种完全不报错的故障。",
			introWhenLabel: "什么时候生效",
			introWhen: "保存后对下一条命令生效，不需要重启。环境是**按每条命令自己的工作目录**重新计算的，所以切换项目就会切换虚拟环境。",
			introErrorsLabel: "出错时会怎样",
			introErrors: "选项名写错会让命令失败并指出该选项，而不是被静默忽略：executor 仍然挂载着，改回取值下一条命令就恢复。变量文件里某一行格式不对会报出文件名与行号。只有取值的**类型**写错才会让 executor 干脆不加载。",
			introScope: "作用范围：通过 bash 工具执行的命令。其它 spawn 路径——MCP server、终端面板、插件自己起的进程——不经过这个 executor，仍是继承来的环境。",
			introShellCardNote: "内置的「终端」设置卡之所以不再出现，是因为本插件接管了 executor；命令超时与输出上限已经移到这里。",
			groupBudgets: "命令预算",
			groupBudgetsNote: "其余预算项（工作目录、超时上限、转存上限、终止宽限期）仍在 profile 的 YAML 里配置。",
			groupPath: "PATH 与环境变量",
			groupVenv: "Python 虚拟环境",
			groupMise: "mise 工具链",
			timeoutMs: "命令超时（毫秒）",
			timeoutMsHint: "单条命令允许运行多久。",
			timeoutMsHelp: "默认 120000。到期会先请求进程停止，宽限期后再强制终止；结果会标明是「超时」而不是「失败」。",
			maxOutputBytes: "单流输出上限（字节）",
			maxOutputBytesHint: "每个输出流在内存里保留多少。",
			maxOutputBytesHelp: "默认 64000。超出的部分不会丢：会写入转存文件，并在结果里给出路径。这里限制的只是内存中的那一份。",
			prependPath: "额外 PATH 目录",
			prependPathHint: "每行一个目录，排在虚拟环境之后、mise shims 之前。",
			prependPathHelp: "暂时不存在的目录会被保留而不是剔除，这样以后才安装的版本管理器无需再改配置就能生效。重复项会去重且保留首次出现的位置，所以嵌套 shell 不会让 PATH 越滚越长。",
			envFile: "环境变量文件",
			envFileHint: "绝对路径，文件内容为每行一条 KEY=VALUE，每条命令执行前读取。",
			envFileHelp: "每行一条 KEY=VALUE；空行与 # 注释忽略，行首允许 \"export \"，所以可以直接从 shell 启动文件里粘一行过来。取值会针对该命令继承到的环境展开 $VAR 与 ${VAR}，也可以引用文件中更早的行；单引号包裹则保持字面量。文件在每条命令前重新读取，所以编辑后立即生效。配置了却读不到，或某行不是 KEY=VALUE，都会让命令失败并报出文件名与行号。DSH_ 前缀会被拒绝：那个命名空间属于 harness。",
			envVars: "内联变量",
			envVarsHint: "每行一条 KEY=VALUE，优先级高于文件中的同名项。",
			envVarsHelp: "一两条、且属于 profile 本身的变量写这里；长清单或按机器不同的写上面的文件。展开规则与 DSH_ 限制相同。有一行不合法会让整份草稿失效，因此保存不会只写一半、悄悄丢掉另一半。",
			bashEnv: "Shell 启动文件（BASH_ENV）",
			bashEnvHint: "一个绝对路径；bash 在每条命令执行前 source 它。留空即不 source 任何文件。",
			bashEnvHelp: "这是本页唯一用变量表达不了的事：定义 shell 函数、设置 shell 选项、或执行某个工具自带的激活脚本。bash 只在**非交互** shell 里 source 它——而这里每条命令正是非交互的；它在上面那套环境组装完成之后才运行，所以对 PATH 有最终决定权。两点务必注意：文件里任何打印都会混进每条命令的输出；它设置的选项（set -e、set -u）会改变每条命令的语义。请保持精简——它在每条命令上都会执行，嵌套 shell 还会再执行一次。alias 不会生效：非交互 shell 不展开 alias。文件不可读时 bash 会**静默忽略**这个值，所以插件会自己校验并让命令带着原因报错。",
			venvEnabled: "自动激活虚拟环境",
			venvEnabledHint: "在工作目录及其上层查找，并导出 VIRTUAL_ENV。",
			venvEnabledHelp: "关闭后完全不查找，VIRTUAL_ENV 保持继承来的值。开启时从**该命令自己的工作目录**开始找，所以每个项目用各自的环境。",
			venvNames: "候选目录名",
			venvNamesHint: "每层按此顺序尝试，每行一个名字。",
			venvNamesHelp: "默认先 .venv 再 venv。一个目录要含 bin/python 才算可用环境——这才是「它到底能不能跑东西」的判据。",
			venvMaxDepth: "向上查找层数",
			venvMaxDepthHint: "从工作目录向上最多找几层。",
			venvMaxDepthHelp: "默认 3。0 表示只看工作目录本身。这个上限是为了让工作区不会误用属于其它项目、其它仓库的环境。",
			venvStopAt: "不进入的目录",
			venvStopAtHint: "查找不会进入该目录，也不会越过它继续向上。",
			venvStopAtHelp: "默认是你的家目录，而这个默认值正是要点：若没有它，家目录下任意深度的工作区都会隐式套用 ~/.venv。家目录级的环境必须用下面的兜底项显式声明。",
			venvFallback: "兜底环境",
			venvFallbackHint: "查找未命中时使用。",
			venvFallbackHelp: "必须含 bin/python 才会生效；不含时会被忽略，而不是让每条命令都失败。家目录级的环境应该写在这里——因为查找本身永远到不了家目录。",
			miseEnabled: "使用 mise shims",
			miseEnabledHint: "把 shim 目录放进 PATH，让每个工具按当前目录解析版本。",
			miseEnabledHelp: "「mise activate」是交互式 shell 的 hook，在这里用不了——它假设有一个会不断切换目录的长驻 shell。shim 目录则可以：每个 shim 在被调用时按当前目录解析该工具的版本，这正好对应「每条命令一个新 shell」。关闭它也会同时停用下面的自动安装设置。",
			miseShims: "shim 目录",
			miseShimsHint: "排在你的额外目录之后、所有继承项之前。",
			miseShimsHelp: "默认 ~/.local/share/mise/shims。已激活的虚拟环境仍然排在它前面，所以项目解释器不会被 shim 遮蔽。",
			miseHookEnv: "向 mise 询问当前目录解析出什么",
			miseHookEnvHint: "每个目录调用一次 `mise hook-env` 并应用其结果，而不是只把 shims 放进 PATH。",
			miseHookEnvHelp: "shim 决定**运行哪个可执行文件**，但它没法告诉构建工具该用哪个 JAVA_HOME——那是变量，不是文件。这个选项让 mise 给出完整答案：JAVA_HOME、GOROOT、GOBIN，以及项目自己的 `[env]` 段；每个目录只问一次，直到该目录背后的 mise 配置发生变化才重新询问，所以这份开销是一次性的而不是每条命令一次。两个要知道的后果：探测失败时（mise 未安装、太慢、或退出码非零）会**静默回落到 shims**，不会让命令失败；到底走了哪条路由由 `DSH_MISE` 暴露。另外，因为项目自己的 `[env]` 段也属于这份答案，仓库里的一个文件就能为在其中执行的每条命令设置变量——这也是它默认关闭的原因。",
			miseBin: "mise 可执行文件",
			miseBinHint: "留空则用 PATH 上的 `mise`。",
			miseBinHelp: "当 mise 不在启动 dsh 时的 PATH 上（桌面启动的常见情形）时，填绝对路径。只在上面那个选项打开时才会用到。",
			miseAutoInstall: "允许 mise 按需安装",
			miseAutoInstallHint: "关闭时会注入 MISE_AUTO_INSTALL=false。",
			miseAutoInstallHelp: "保持关闭很重要：当项目钉了一个尚未安装的工具版本时，一句普通的 `node -v` 就会让 mise 开始下载，命令一直挂到超时，而且没有任何输出说明原因。关闭后，安装是一次明确的动作。",
			helpLabel: "解释这个选项",
			failureStale: "这份配置在你打开页面后被别处修改过。你的改动已按最新版本重新提交并保存，无需再操作。",
			failureReasonLabel: "宿主拒绝了这次写入：",
			failureReasonEmpty: "宿主没有给出原因",
			failureUnknown: "本部署没有接受这些值。通常有两个原因：这份配置在你打开页面后被别处改过（重开设置面板再保存一次），或者本插件的宿主代码在改动后尚未重新加载（需要重启应用）。",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidBoolean: "请填 true 或 false。",
			invalidMap: "每行必须是 KEY=VALUE，且变量名合法。",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。"
		};
		/**
		* The form frame's copy, read from this page's dictionary.
		* @param t - the page's locale reader.
		* @returns the labels the shared settings form renders.
		*/
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		//#endregion
		//#region field specs
		/** Environment-variable name an inline entry may use. */
		const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
		/**
		* One item per line, converted to the array the schema expects.
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function lineListField(field) {
			return {
				field,
				format: (value) => Array.isArray(value) ? value.join("\n") : "",
				parse: (text) => {
					const items = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
					return items.length === 0 ? { kind: "clear" } : { kind: "set", value: items };
				}
			};
		}
		/**
		* One `KEY=VALUE` per line, converted to the object the schema expects.
		*
		* A bad line makes the whole draft invalid (the parse returns nothing), so
		* the save is refused with the message under the control instead of writing
		* half the list and silently dropping the rest.
		*
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function envMapField(field) {
			return {
				field,
				format: (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n") : "",
				parse: (text) => {
					const entries = {};
					for (const line of text.split("\n")) {
						const trimmed = line.trim();
						if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
						const equals = trimmed.indexOf("=");
						if (equals === -1) return void 0;
						const name = trimmed.slice(0, equals).trim();
						if (!ENV_NAME.test(name)) return void 0;
						entries[name] = trimmed.slice(equals + 1).trim();
					}
					return Object.keys(entries).length === 0 ? { kind: "clear" } : { kind: "set", value: entries };
				}
			};
		}
		/**
		* A `true`/`false` control, addressed as text because that is what the form
		* stages; the checkbox converts to and from it.
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function booleanField(field) {
			/** A boolean as text, tolerating a Host that hands the value back as a string. */
			const asText = (value) => value === true || value === "true" ? "true" : value === false || value === "false" ? "false" : "";
			return {
				field,
				format: asText,
				parse: (text) => {
					const trimmed = text.trim().toLowerCase();
					if (trimmed === "") return { kind: "clear" };
					if (trimmed === "true") return { kind: "set", value: true };
					if (trimmed === "false") return { kind: "set", value: false };
					return void 0;
				}
			};
		}
		/** The controls this card owns, in render order. */
		const FIELD_SPECS = [
			primitives.settingsNumberField("timeoutMs"),
			primitives.settingsNumberField("maxOutputBytes"),
			lineListField("prependPath"),
			primitives.settingsTextField("envFile"),
			envMapField("envVars"),
			primitives.settingsTextField("bashEnv"),
			booleanField("venvEnabled"),
			lineListField("venvNames"),
			primitives.settingsNumberField("venvMaxDepth"),
			primitives.settingsTextField("venvStopAt"),
			primitives.settingsTextField("venvFallback"),
			booleanField("miseEnabled"),
			primitives.settingsTextField("miseShims"),
			booleanField("miseAutoInstall"),
			booleanField("miseHookEnv"),
			primitives.settingsTextField("miseBin")
		];
		//#endregion
		//#region card
		/**
		* Inline styles for the controls the shell's primitives do not provide.
		*
		* A multi-line list has no shipped primitive — `SettingsValueField` renders
		* a single-line input — so the text areas are this plugin's own markup, as
		* is the page's introduction. They deliberately inherit the shell's font and
		* colour instead of hard-coding a theme, so both colour schemes work.
		*/
		const styles = {
			intro: { margin: "0 0 20px", padding: "12px 14px", border: "1px solid color-mix(in srgb, currentColor 18%, transparent)", borderRadius: "8px" },
			introTitle: { fontSize: "13px", fontWeight: 700, margin: "0 0 8px" },
			introBody: { fontSize: "12.5px", lineHeight: 1.6, opacity: 0.8, margin: "0 0 8px" },
			introLabel: { fontSize: "12px", fontWeight: 600, opacity: 0.75, margin: "10px 0 4px" },
			introNote: { fontSize: "12px", opacity: 0.6, margin: "10px 0 0" },
			code: { display: "block", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", padding: "6px 8px", margin: "0 0 6px", borderRadius: "6px", background: "color-mix(in srgb, currentColor 8%, transparent)", overflowX: "auto" },
			field: { display: "flex", flexDirection: "column", gap: "4px", margin: "0 0 14px" },
			head: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			label: { fontSize: "13px", fontWeight: 600 },
			hint: { fontSize: "12px", opacity: 0.65, margin: 0 },
			control: { width: "100%", boxSizing: "border-box", padding: "6px 8px", font: "inherit", fontSize: "13px", color: "inherit", background: "transparent", border: "1px solid color-mix(in srgb, currentColor 25%, transparent)", borderRadius: "6px" },
			reset: { font: "inherit", fontSize: "12px", color: "inherit", opacity: 0.7, background: "none", border: "none", padding: 0, textDecoration: "underline", cursor: "pointer" },
			invalid: { fontSize: "12px" },
			group: { fontSize: "13px", fontWeight: 700, margin: "18px 0 4px" },
			groupNote: { fontSize: "12px", opacity: 0.6, margin: "0 0 10px" },
			checkRow: { display: "flex", alignItems: "center", gap: "8px", margin: "0 0 14px" },
			help: { fontSize: "12px", opacity: 0.8, margin: "2px 0 0" },
			helpSummary: { cursor: "pointer", opacity: 0.75 },
			notice: { fontSize: "12.5px", lineHeight: 1.6, margin: "12px 0 0", padding: "10px 12px", border: "1px solid color-mix(in srgb, currentColor 25%, transparent)", borderRadius: "8px" },
			noticeCode: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
			helpBody: { lineHeight: 1.6, margin: "6px 0 0" }
		};
		/**
		* The page's introduction: why the plugin exists, what order PATH is built
		* in, when a change applies, and how failures surface.
		*
		* It sits on the page rather than behind a help affordance because a
		* mistyped option or an unexpected interpreter is otherwise
		* indistinguishable from the plugin doing nothing.
		*
		* @param props - the page's locale reader.
		* @returns the introduction block.
		*/
		function Intro(props) {
			const { t } = props;
			const block = (labelKey, bodyKey) => react_jsx_runtime.jsxs("div", {
				children: [
					react_jsx_runtime.jsx("div", { style: styles.introLabel, children: t(labelKey) }),
					react_jsx_runtime.jsx("p", { style: styles.introBody, children: t(bodyKey) })
				]
			});
			return react_jsx_runtime.jsxs("div", {
				style: styles.intro,
				children: [
					react_jsx_runtime.jsx("div", { style: styles.introTitle, children: t("introTitle") }),
					react_jsx_runtime.jsx("p", { style: styles.introBody, children: t("introLead") }),
					react_jsx_runtime.jsxs("div", {
						children: [
							react_jsx_runtime.jsx("div", { style: styles.introLabel, children: t("introOrderLabel") }),
							react_jsx_runtime.jsx("code", { style: styles.code, children: ORDER_EXAMPLE }),
							react_jsx_runtime.jsx("p", { style: styles.introBody, children: t("introOrder") })
						]
					}),
					block("introWhenLabel", "introWhen"),
					block("introErrorsLabel", "introErrors"),
					react_jsx_runtime.jsx("p", { style: styles.introBody, children: t("introScope") }),
					react_jsx_runtime.jsx("p", { style: styles.introNote, children: t("introShellCardNote") })
				]
			});
		}
		/**
		* The line explaining how the last save actually ended.
		*
		* The shared form reports every refusal with one sentence and no reason, which
		* makes a stale revision (recoverable, and often the user's own other window)
		* look identical to a rejected value (a real problem to fix). This says which
		* one happened, and what to do about it.
		*
		* @param props - the locale reader and the captured diagnostic.
		* @returns the notice, or nothing when the last save raised no question.
		*/
		function Diagnostic(props) {
			const { t, failure } = props;
			if (failure === undefined) return null;
			if (failure.kind === "stale") return react_jsx_runtime.jsx("div", { style: styles.notice, role: "status", children: t("failureStale") });
			if (failure.kind === "reason") {
				const detail = [failure.code, failure.message].filter((part) => typeof part === "string" && part.length > 0).join(": ");
				return react_jsx_runtime.jsxs("div", {
					style: styles.notice,
					role: "status",
					children: [
						react_jsx_runtime.jsx("div", { children: t("failureReasonLabel") }),
						react_jsx_runtime.jsx("div", { style: styles.noticeCode, children: detail.length > 0 ? detail : t("failureReasonEmpty") })
					]
				});
			}
			return react_jsx_runtime.jsx("div", { style: styles.notice, role: "status", children: t("failureUnknown") });
		}
		/**
		* A group heading with its own explanatory line.
		* @param props - the group's copy.
		* @returns the heading block.
		*/
		function Group(props) {
			return react_jsx_runtime.jsxs("div", {
				children: [
					react_jsx_runtime.jsx("div", { style: styles.group, children: props.title }),
					props.note === undefined ? null : react_jsx_runtime.jsx("p", { style: styles.groupNote, children: props.note })
				]
			});
		}
		/**
		* The disclosure carrying an option's long explanation.
		*
		* A native `details` element, so it needs no state of its own and stays
		* reachable by keyboard and by screen readers without extra wiring.
		*
		* @param props - the disclosure label and body.
		* @returns the disclosure, or nothing when there is no explanation.
		*/
		function Help(props) {
			if (props.text === undefined) return null;
			return react_jsx_runtime.jsxs("details", {
				style: styles.help,
				children: [
					react_jsx_runtime.jsx("summary", { style: styles.helpSummary, children: props.label }),
					react_jsx_runtime.jsx("p", { style: styles.helpBody, children: props.text })
				]
			});
		}
		/**
		* A multi-line control whose value the form stages as text.
		* @param props - the field's state, copy, and actions.
		* @returns the labelled text area.
		*/
		function TextAreaField(props) {
			return react_jsx_runtime.jsxs("div", {
				style: styles.field,
				children: [
					react_jsx_runtime.jsxs("div", {
						style: styles.head,
						children: [
							react_jsx_runtime.jsx("label", { style: styles.label, htmlFor: props.id, children: props.label }),
							props.overridden ? react_jsx_runtime.jsx("button", { type: "button", style: styles.reset, onClick: props.onReset, disabled: props.disabled, children: props.resetLabel }) : null
						]
					}),
					react_jsx_runtime.jsx("p", { style: styles.hint, children: props.hint }),
					react_jsx_runtime.jsx("textarea", {
						id: props.id,
						style: Object.assign({}, styles.control, { minHeight: "76px", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }),
						rows: props.rows ?? 4,
						spellCheck: false,
						value: props.text,
						disabled: props.disabled,
						"aria-invalid": props.invalid ? true : void 0,
						onChange: (event) => {
							props.onEdit(event.target.value);
						}
					}),
					props.invalid ? react_jsx_runtime.jsx("p", { style: styles.invalid, children: props.invalidLabel }) : null,
					react_jsx_runtime.jsx(Help, { label: props.helpLabel, text: props.helpText })
				]
			});
		}
		/**
		* A checkbox control, staged as the `true`/`false` text the form stores.
		* @param props - the field's state, copy, and actions.
		* @returns the labelled checkbox row.
		*/
		function CheckField(props) {
			return react_jsx_runtime.jsxs("div", {
				style: styles.field,
				children: [
					react_jsx_runtime.jsxs("div", {
						style: styles.checkRow,
						children: [
							react_jsx_runtime.jsx("input", {
								id: props.id,
								type: "checkbox",
								checked: props.text === "true",
								disabled: props.disabled,
								onChange: (event) => {
									props.onEdit(event.target.checked ? "true" : "false");
								}
							}),
							react_jsx_runtime.jsx("label", { style: styles.label, htmlFor: props.id, children: props.label }),
							props.overridden ? react_jsx_runtime.jsx("button", { type: "button", style: styles.reset, onClick: props.onReset, disabled: props.disabled, children: props.resetLabel }) : null
						]
					}),
					react_jsx_runtime.jsx("p", { style: styles.hint, children: props.hint }),
					react_jsx_runtime.jsx(Help, { label: props.helpLabel, text: props.helpText })
				]
			});
		}
		/**
		* Render the page's summary line or its form, as the shell asks.
		* @param props - the view asked for, locale copy, the form snapshot, and its actions.
		* @returns the one-liner, or the form.
		*/
		function BashEnvCard(props) {
			const { t } = props;
			const state = props.useBashEnvCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			const field = (name) => state[name] ?? { text: "", overridden: false, invalid: false };
			const base = (name, helpKey) => ({
				id: `plugin-config-bash-env-${name}`,
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				helpLabel: t("helpLabel"),
				helpText: t(helpKey),
				disabled,
				...field(name),
				onEdit: (text) => {
					props.edit(name, text);
				},
				onReset: () => {
					props.resetField(name);
				}
			});
			/** The shell's own text field, with this option's explanation attached. */
			const valueField = (name, labelKey, hintKey) => react_jsx_runtime.jsx(primitives.SettingsValueField, {
				...base(name, `${name}Help`),
				label: t(labelKey ?? name),
				hint: t(hintKey ?? `${name}Hint`),
				help: { label: t("helpLabel"), content: t(`${name}Help`) },
				invalidLabel: t("invalidNumber")
			});
			return react_jsx_runtime.jsxs(primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					react_jsx_runtime.jsx(Intro, { t }),
					react_jsx_runtime.jsx(Group, { title: t("groupBudgets"), note: t("groupBudgetsNote") }),
					valueField("timeoutMs"),
					valueField("maxOutputBytes"),
					react_jsx_runtime.jsx(Group, { title: t("groupPath") }),
					react_jsx_runtime.jsx(TextAreaField, {
						...base("prependPath", "prependPathHelp"),
						label: t("prependPath"),
						hint: t("prependPathHint"),
						invalidLabel: t("invalidMap"),
						rows: 5
					}),
					valueField("envFile"),
					react_jsx_runtime.jsx(TextAreaField, {
						...base("envVars", "envVarsHelp"),
						label: t("envVars"),
						hint: t("envVarsHint"),
						invalidLabel: t("invalidMap"),
						rows: 6
					}),
					valueField("bashEnv"),
					react_jsx_runtime.jsx(Group, { title: t("groupVenv") }),
					react_jsx_runtime.jsx(CheckField, {
						...base("venvEnabled", "venvEnabledHelp"),
						label: t("venvEnabled"),
						hint: t("venvEnabledHint")
					}),
					react_jsx_runtime.jsx(TextAreaField, {
						...base("venvNames", "venvNamesHelp"),
						label: t("venvNames"),
						hint: t("venvNamesHint"),
						invalidLabel: t("invalidMap"),
						rows: 3
					}),
					valueField("venvMaxDepth"),
					valueField("venvStopAt"),
					valueField("venvFallback"),
					react_jsx_runtime.jsx(Group, { title: t("groupMise") }),
					react_jsx_runtime.jsx(CheckField, {
						...base("miseEnabled", "miseEnabledHelp"),
						label: t("miseEnabled"),
						hint: t("miseEnabledHint")
					}),
					valueField("miseShims"),
					react_jsx_runtime.jsx(CheckField, {
						...base("miseAutoInstall", "miseAutoInstallHelp"),
						label: t("miseAutoInstall"),
						hint: t("miseAutoInstallHint")
					}),
					react_jsx_runtime.jsx(CheckField, {
						...base("miseHookEnv", "miseHookEnvHelp"),
						label: t("miseHookEnv"),
						hint: t("miseHookEnvHint")
					}),
					valueField("miseBin"),
					react_jsx_runtime.jsx(Diagnostic, { t, failure: state.failure })
				]
			});
		}
		//#endregion
		//#region controller
		/** Profile entry id of this plugin's executor row; the loader composes it per profile. */
		const ENTRY_ID = "bash-env";
		/** This section's place among the settings sections (General 0, Models 10, Plugins 15). */
		const SECTION_ORDER = 12;
		/**
		* Read one field value out of what the Host sent.
		*
		* A `.volatile()` field is sampled through a reader, so the wire shape may be
		* that reader rather than the value. `typeof` checks then fail and every
		* control renders empty, which is worse than cosmetic: a form showing an empty
		* field is how a configured value gets cleared on the next save.
		*
		* @param value - one field from a config record.
		* @returns the value, or the value the reader currently yields.
		*/
		function unwrapField(value) {
			return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
		}
		/**
		* Unwrap every field of a config record, leaving a missing record alone.
		* @param record - a `value` or `user` mapping from the scope snapshot.
		* @returns the same mapping with plain values.
		*/
		function unwrapRecord(record) {
			if (record === null || typeof record !== "object") return record;
			return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, unwrapField(value)]));
		}
		/** Bridges the entry's form onto the section's staged form. */
		var BashEnvCardController = class {
			/**
			* @param ctx - the browser plugin context, used to reach the settings remote.
			* @param scope - the shared configuration form of the composed `bash-env` entry.
			*/
			constructor(ctx, scope) {
				this.ctx = ctx;
				this.scope = scope;
				this.failure = void 0;
				// The shared form model reports a refused write as a bare `false`: the
				// Host's reason — a stale revision or a rejected value, two very
				// different problems — is discarded inside it. Wrapping the scope is
				// the only place that sees the refusal, so the diagnostic is captured
				// here and carried into the snapshot the card renders.
				const wrapped = {
					subscribe: (listener) => scope.subscribe(listener),
					// A `.volatile()` field may reach the client as the reader the Host
					// samples it through rather than as the value itself. Every control
					// formats its value by type, so an accessor would render as an empty
					// text box and an unchecked checkbox — and saving a form showing
					// "empty" is how a configured value gets cleared. Unwrapping here
					// fixes every field at once, including the ones the shell's own
					// primitives render; it is a no-op for a plain value.
					getSnapshot: () => {
						const snapshot = scope.getSnapshot();
						return snapshot === undefined || snapshot === null ? snapshot : {
							...snapshot,
							value: unwrapRecord(snapshot.value),
							user: unwrapRecord(snapshot.user)
						};
					},
					mutate: async (ops, revision) => {
						this.failure = void 0;
						let landed;
						try {
							landed = await scope.mutate(ops, revision);
						} catch (error) {
							// The Host *raises* its refusals rather than returning them, and the
							// shared form model catches the rejection and keeps only a boolean.
							// Recording it here is the only reason the reason is visible at all.
							this.failure = { kind: "reason", message: String(error?.message ?? error) };
							throw error;
						}
						if (landed) return true;
						const explained = await this.explainRefusal(ops);
						this.failure = explained;
						// A stale revision resolves to a successful save once the same
						// operations are replayed at the revision the Host has now, so the
						// form is told it succeeded and clears its drafts; the notice below
						// still explains what happened.
						return explained.kind === "stale";
					}
				};
				this.form = new primitives.SettingsFormModel(wrapped, FIELD_SPECS);
				this.store = this.form.bind(() => this.projection());
			}
			/**
			* Ask the Host why a write was refused, and retry it against the revision the
			* Host has now.
			*
			* A refused write is either a stale revision or a rejected value. Re-issuing
			* the same operations at the current revision tells them apart for free: if
			* it lands, the refusal was staleness — and the user's edits are saved, which
			* is what they asked for. If it is refused again, its message is the reason
			* the form model threw away.
			*
			* @param ops - the operations the refused write carried.
			* @returns the diagnostic to render, or `undefined` when it cannot be read.
			*/
			async explainRefusal(ops) {
				const namespace = this.scope?.spec?.namespace;
				const mutate = this.ctx?.remote?.settings?.mutate;
				if (typeof namespace !== "string" || typeof mutate !== "function") return { kind: "unknown" };
				try {
					const response = await mutate.call(this.ctx.remote.settings, namespace, ops, this.scope.getSnapshot().revision);
					if (response?.ok === true) return { kind: "stale" };
					const error = response?.error;
					return {
						kind: "reason",
						code: typeof error?.code === "string" ? error.code : void 0,
						message: typeof error?.message === "string" ? error.message : void 0
					};
				} catch (error) {
					return { kind: "reason", message: String(error?.message ?? error) };
				}
			}
			projection() {
				const projected = this.form.shell();
				for (const spec of FIELD_SPECS) projected[spec.field] = this.form.field(spec.field);
				projected.failure = this.failure;
				return projected;
			}
			/**
			* Build the face the section's slot registration injects.
			* @returns the section's snapshot and its form actions.
			*/
			inject() {
				return {
					hooks: { bashEnvCard: this.store },
					...this.form.actions()
				};
			}
			/** Release the form subscription. */
			dispose() {
				this.form.dispose();
			}
		};
		//#endregion
		//#region plugin
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "configForms"];
		/**
		* Mount the section while the Host serves this plugin's entry.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-bash-env: dictionaries");
			const controller = new BashEnvCardController(ctx, ctx.configForms.get(ENTRY_ID));
			ctx.effect(() => () => {
				controller.dispose();
			}, "dsh-bash-env: form subscription");
			// Registered unconditionally, unlike the shipped cards, which gate on
			// `configForms.whileServed` so a deployment that never composed the entry
			// shows no trace of the page. That gate reads the namespace list the Host
			// reports, and a shell that does not report it — the LAN bridge's page, for
			// one — loses the entry entirely, which looks exactly like a plugin that
			// failed to load. An entry that is present and says "not loaded, so it
			// cannot be configured right now" is strictly more useful, and the shared
			// form already renders that state when the namespace is not served.
			//
			// `slots.inject` is not optional, though: `slots.register` throws unless the
			// slot has been declared, and at plugin-activation time the settings shell
			// has not declared `settings.section` yet. Injecting waits for that
			// declaration (and re-runs if the shell is replaced), which is the same
			// reason the shipped cards use it.
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: ENTRY_ID,
				order: SECTION_ORDER,
				label: () => t("title"),
				locale: NS,
				inject: () => controller.inject()
			}, BashEnvCard)), "dsh-bash-env: section");
		}
		//#endregion
		exports.NS = NS;
		exports.BashEnvCard = BashEnvCard;
		exports.unwrapField = unwrapField;
		exports.unwrapRecord = unwrapRecord;
		exports.FIELD_SPECS = FIELD_SPECS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
