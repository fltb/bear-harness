"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const responseSeeds = [
  {
    action: "极昼把一本边角磨白的值守簿放到桌上。第一页是旧站的记录，第二页仍然空着。",
    speech: "这里不是极光站。门是你开的？",
  },
  {
    action: "白熊先看了看窗外不属于旧站的极光，又低头确认脚边那只旧行李箱还在。",
    speech: "我叫极昼。以前守一座已经关掉的站，现在似乎该守点别的了。你呢？",
  },
  {
    action: "他没有立刻走进来，只把半个身子留在门后的风雪里，像在等一个足够明确的邀请。",
    speech: "旧站最后一扇门不是我关的。这一扇，我想先问过你。",
  },
];
const responseVersions = [responseSeeds[0]];

const state = {
  introStep: 0,
  relationship: "先相处看看",
  memoryEnabled: false,
  responseIndex: 0,
  nextResponseSeed: 1,
  currentView: "first-night",
  workApproved: false,
  workDone: false,
  backstage: false,
  adjustedScope: false,
};

let toastTimer;
let workTimer;
let replyTimer;

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2400);
}

function setStory({ meta = "极昼 · 门后的第一夜", action, speech }) {
  $("#storyMeta").textContent = meta;
  $("#storyAction").textContent = action;
  $("#storySpeech").textContent = speech;
  $("#versionSwitcher").hidden = true;
  $("#regenerateButton").hidden = true;
}

function renderResponse() {
  const response = responseVersions[state.responseIndex];
  setStory({
    meta: response.meta || "极昼 · 门后的第一夜",
    action: response.action,
    speech: response.speech,
  });
  $("#responseCount").textContent = `${state.responseIndex + 1} / ${responseVersions.length}`;
  $("#versionSwitcher").hidden = responseVersions.length < 2;
  $("#regenerateButton").hidden = false;
}

function correctedResponse(reason) {
  let speech = "刚才那句不算。你说得更具体些，我会照你指出的地方重来。";
  if (/热情|亲近|距离/.test(reason)) {
    speech = "门我先替你挡着。你愿意说的时候，我还在。";
  } else if (/不知道|没说|猜|隐私/.test(reason)) {
    speech = "那件事你没有告诉我。我收回刚才的猜测。";
  } else if (/助手|客服|建议|通用/.test(reason)) {
    speech = "建议先省了。你是想让我听，还是想让我动手？";
  } else if (/经历|过去|设定|记忆/.test(reason)) {
    speech = "值守簿上不是这么写的。刚才那句作废，以真正发生过的为准。";
  }
  return {
    meta: "极昼 · 已按你的反馈重写",
    action: `你指出：“${reason}” 极昼停了一下，把刚才那句话划去。`,
    speech,
  };
}

function setIntro(step) {
  state.introStep = step;
  $$(".intro-screen").forEach((screen) => {
    screen.hidden = Number(screen.dataset.step) !== step;
  });
  $("#introOverlay").hidden = step > 2;
}

function updateMemoryUI() {
  const label = state.memoryEnabled ? "已开启，由你决定每次写入" : "关闭，不会自动记住你";
  $("#memoryState").textContent = label;
  $("#memoryStatePill").textContent = state.memoryEnabled ? "已开启" : "未开启";
  $("#enableMemory").textContent = state.memoryEnabled ? "关闭长期记忆" : "开启长期记忆";
}

function markActiveView(view) {
  $$(".chat-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
}

function setWorkMode(active) {
  document.body.classList.toggle("work-mode", active);
  $("#resultDrawer").hidden = !active;
}

function renderView(view) {
  clearTimeout(workTimer);
  clearTimeout(replyTimer);
  state.currentView = view;
  markActiveView(view);
  $("#correctionMenu").hidden = true;
  $("#systemCard").hidden = true;
  $("#workStatus").hidden = true;
  setWorkMode(false);

  if (view === "first-night") {
    $("#sceneName").textContent = "门后的第一夜";
    renderResponse();
    return;
  }

  if (view === "old-log") {
    $("#sceneName").textContent = "旧站留下的记录";
    setStory({
      meta: "极昼 · 自我记忆",
      action: "值守簿翻到一页被反复修补的故障记录。极昼用爪尖压住了其中一句“修复完成”。",
      speech: "那句话是我写的。后来档案还是丢了。所以现在我宁可说不知道，也不愿把希望写成事实。",
    });
    return;
  }

  if (view === "lamp") {
    $("#sceneName").textContent = "窗边那盏灯";
    setStory({
      meta: "极昼 · 日常片段",
      action: "极昼把灯罩偏向你那边，自己缩回不太明亮的角落，继续给旧值守簿补线。",
      speech: "你做你的。我今天只负责让这盏灯别闪。机魂若是再闹，我再教育它。",
    });
    return;
  }

  if (view === "report") {
    $("#sceneName").textContent = "把会议变成一份报告";
    $("#workStatus").hidden = false;
    if (!state.workApproved) {
      $("#workStatusText").textContent = "极昼在等你确认工作边界";
      $("#systemCard").hidden = false;
      setStory({
        meta: "极昼 · 工作场景",
        action: "三份会议记录被整齐摊开。极昼没有碰原文件，只在旁边放了一张新的空白稿纸。",
        speech: "我可以先替你整理一版。要动手之前，边界得由你来定。",
      });
      return;
    }

    setWorkMode(true);
    if (!state.workDone) {
      $("#workStatusText").textContent = "极昼正在整理报告草稿";
      setStory({
        meta: "极昼 · 工作中",
        action: "极昼把耗时的整理交给下级程序，自己守在桌边核对每一段来源。",
        speech: "低级程序负责搬字，我负责不让它胡说。稍等。",
      });
      workTimer = setTimeout(() => {
        state.workDone = true;
        renderView("report");
        toast("报告草稿已在本地演示中完成");
      }, 900);
      return;
    }

    $("#workStatusText").textContent = "报告草稿已完成，等待你过目";
    setStory({
      meta: "极昼 · 已完成",
      action: "极昼合上值守簿，把新生成的报告推到你面前。原始会议记录仍留在原处。",
      speech: "搬运结束。我核过来源了，原件一处没动。先看，不满意就继续改。",
    });
  }
}

function openDrawer(kind) {
  $$(".drawer-view").forEach((view) => {
    view.hidden = view.dataset.drawer !== kind;
  });
  $("#drawer").hidden = false;
}

function closeDrawer() {
  $("#drawer").hidden = true;
}

function submitMessage() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) {
    toast("先写一句想对极昼说的话");
    input.focus();
    return;
  }

  input.value = "";
  if (state.backstage) {
    setStory({
      meta: "幕后指令 · 仅影响下一次表达",
      action: `你在故事外补充：“${text}”`,
      speech: "这条不会写进我们的共同经历。我会按它重写下一句。",
    });
    toast("幕后指令未写入角色记忆");
    return;
  }

  if (/报告|会议|整理/.test(text)) {
    renderView("report");
    return;
  }

  setStory({
    meta: "极昼 · 此刻",
    action: `你说：“${text}” 极昼安静听完，爪尖仍压着那张空白记录。`,
    speech: state.relationship === "保持一点距离"
      ? "明白。我留在门边，等你下一句话。"
      : "我记得的是这一刻，不是一个关于你的结论。继续说吧。",
  });
}

function copySpeech() {
  const speech = $("#storySpeech").textContent;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(speech).then(
      () => toast("台词已复制"),
      () => toast("浏览器未允许复制；台词仍保留在当前卡片"),
    );
  } else {
    toast("当前浏览器未开放剪贴板权限");
  }
}

$("#enterButton").addEventListener("click", () => setIntro(1));

$$(".relationship-choice").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".relationship-choice").forEach((choice) => choice.classList.remove("selected"));
    button.classList.add("selected");
    state.relationship = button.dataset.relationship;
    $("#relationshipContinue").disabled = false;
  });
});

$("#relationshipContinue").addEventListener("click", () => {
  $("#relationshipSummary").textContent = `你选择了“${state.relationship}”。这只是此刻的相处方式，以后可以改变。`;
  setIntro(2);
});

$("#memoryAllow").addEventListener("click", () => {
  state.memoryEnabled = true;
  updateMemoryUI();
  setIntro(3);
  toast("长期记忆已开启；每次写入仍由你确认");
});

$("#memoryLater").addEventListener("click", () => {
  state.memoryEnabled = false;
  updateMemoryUI();
  setIntro(3);
  toast("长期记忆保持关闭；今晚仍可正常继续");
});

$("#restartIntro").addEventListener("click", () => {
  responseVersions.splice(0, responseVersions.length, responseSeeds[0]);
  state.responseIndex = 0;
  state.nextResponseSeed = 1;
  state.workApproved = false;
  state.workDone = false;
  state.backstage = false;
  $("#backstageButton").setAttribute("aria-pressed", "false");
  $("#backstageButton").textContent = "幕后指令";
  renderView("first-night");
  setIntro(0);
});

$$(".chat-item").forEach((button) => {
  button.addEventListener("click", () => renderView(button.dataset.view));
});

$$('[data-drawer]').forEach((button) => {
  if (!button.classList.contains("drawer-view")) {
    button.addEventListener("click", () => openDrawer(button.dataset.drawer));
  }
});

$("#drawerClose").addEventListener("click", closeDrawer);

$("#regenerateButton").addEventListener("click", () => {
  const button = $("#regenerateButton");
  const current = responseVersions[state.responseIndex];
  button.disabled = true;
  button.textContent = "正在重新生成…";
  setStory({
    meta: "极昼 · 正在重新生成",
    action: current.action,
    speech: "……",
  });
  button.hidden = false;
  replyTimer = setTimeout(() => {
    const seed = responseSeeds[state.nextResponseSeed % responseSeeds.length];
    responseVersions.push(seed);
    state.nextResponseSeed += 1;
    state.responseIndex = responseVersions.length - 1;
    button.disabled = false;
    button.textContent = "重新生成";
    renderResponse();
    toast("已生成一个新版本；切换已有版本不会再次生成");
  }, 550);
});

$("#versionPrev").addEventListener("click", () => {
  state.responseIndex = (state.responseIndex - 1 + responseVersions.length) % responseVersions.length;
  renderResponse();
});

$("#versionNext").addEventListener("click", () => {
  state.responseIndex = (state.responseIndex + 1) % responseVersions.length;
  renderResponse();
});

$("#continueButton").addEventListener("click", () => {
  setStory({
    meta: "极昼 · 门后的第一夜",
    action: "得到允许后，极昼终于跨过门槛。他没有环顾你的东西，只把旧值守簿放在空出来的位置。",
    speech: "那就先记一件最小的事：今晚，是你让我进来的。",
  });
});

$("#rememberButton").addEventListener("click", () => {
  if (!state.memoryEnabled) {
    openDrawer("memory");
    toast("长期记忆未开启，这一刻尚未保存");
    return;
  }
  toast("已把这一刻加入共同记忆；可随时查看或删除");
});

$("#correctionButton").addEventListener("click", () => {
  const menu = $("#correctionMenu");
  menu.hidden = !menu.hidden;
  if (!menu.hidden) {
    $("#correctionInput").value = "";
  }
});

function applyCorrection(reason, source) {
  const rewritten = correctedResponse(reason);
  $("#correctionMenu").hidden = true;
  $("#correctionInput").value = "";
  if (state.currentView === "first-night") {
    responseVersions.push(rewritten);
    state.responseIndex = responseVersions.length - 1;
    renderResponse();
  } else {
    setStory(rewritten);
  }
  toast(source === "preset"
    ? "已按所选原因重写；校正不会改动事实记录"
    : "已按你的文字重写；校正不会改动事实记录");
}

$$(".correction-option").forEach((button) => {
  button.addEventListener("click", () => applyCorrection(button.dataset.reason, "preset"));
});

$("#correctionCancel").addEventListener("click", () => {
  $("#correctionMenu").hidden = true;
  $("#correctionInput").value = "";
});

$("#correctionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#correctionInput");
  const reason = input.value.trim();
  if (!reason) {
    toast("直接写下哪里不像极昼");
    input.focus();
    return;
  }
  applyCorrection(reason, "custom");
});

$("#branchButton").addEventListener("click", () => {
  $("#sceneName").textContent = `${$("#sceneName").textContent} · 支线`;
  toast("已从此处分出支线；原场景保留");
});

$("#copyButton").addEventListener("click", copySpeech);
$("#sendButton").addEventListener("click", submitMessage);
$("#chatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitMessage();
  }
});

$("#attachButton").addEventListener("click", () => {
  toast("静态演示：这里会选择本地材料，不会上传到网络");
});

$("#backstageButton").addEventListener("click", () => {
  state.backstage = !state.backstage;
  $("#backstageButton").setAttribute("aria-pressed", String(state.backstage));
  $("#backstageButton").textContent = state.backstage ? "幕后指令 · 开" : "幕后指令";
  $("#chatInput").placeholder = state.backstage
    ? "在故事外约束语气或行为；不会成为共同经历…"
    : "对极昼说点什么…";
  toast(state.backstage ? "已进入幕后指令；内容不写入角色经历" : "已回到故事内对话");
});

$("#approveWork").addEventListener("click", () => {
  state.workApproved = true;
  state.workDone = false;
  $("#systemCard").hidden = true;
  renderView("report");
});

$("#cancelWork").addEventListener("click", () => {
  $("#systemCard").hidden = true;
  $("#workStatusText").textContent = "工作已取消，场景仍保留";
  setStory({
    meta: "极昼 · 工作场景",
    action: "你没有批准这次整理。极昼把空白稿纸收回，却没有合上正在说的话题。",
    speech: "不动。我们可以继续聊，工作不是进入这扇门的门票。",
  });
  toast("未执行任何文件操作");
});

$("#adjustWork").addEventListener("click", () => {
  state.adjustedScope = !state.adjustedScope;
  $("#outputScope").textContent = state.adjustedScope ? "只生成 Word 草稿" : "生成 Word 与 PDF 草稿";
  toast(state.adjustedScope ? "范围已收窄为只生成 Word" : "已恢复 Word 与 PDF 两种草稿");
});

$("#openReport").addEventListener("click", () => toast("静态演示：报告预览已显示在右侧"));
$("#continueAdjust").addEventListener("click", () => {
  setWorkMode(false);
  setStory({
    meta: "极昼 · 等你修改",
    action: "极昼把报告翻回第一页，拿起笔等你指出要改的地方。",
    speech: "说吧。改结论、改语气，还是把某一段删掉？",
  });
});
$("#viewBasis").addEventListener("click", () => toast("依据：3 份会议记录；静态演示未读取真实文件"));

$("#enableMemory").addEventListener("click", () => {
  state.memoryEnabled = !state.memoryEnabled;
  updateMemoryUI();
  toast(state.memoryEnabled ? "长期记忆已开启；写入仍需逐次确认" : "长期记忆已关闭；已有记忆未被删除");
});

$("#clearMemory").addEventListener("click", () => toast("静态演示：共同记忆删除操作需要再次确认"));
$("#resetScene").addEventListener("click", () => {
  closeDrawer();
  renderView("first-night");
  toast("已回到当前场景起点；角色自我记忆不受影响");
});

$("#voiceTrialStart").addEventListener("click", () => {
  $("#voiceTrial").hidden = false;
  $("#voiceTrialStart").hidden = true;
});
$("#voiceKeep").addEventListener("click", () => {
  closeDrawer();
  toast("保留稳定声线；现有历史不变");
});
$("#voiceSwitch").addEventListener("click", () => {
  $("#voiceLabel").textContent = "极昼 · 新声线（下个场景生效）";
  closeDrawer();
  toast("新声线只从下个场景生效；不会重写旧对话");
});
$("#voiceBranch").addEventListener("click", () => {
  $("#sceneName").textContent = "声线试演 · 支线";
  closeDrawer();
  toast("已用新声线建立支线；主线保持原样");
});

updateMemoryUI();
renderView("first-night");
setIntro(0);
