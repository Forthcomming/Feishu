async function postDoc(userText) {
  const res = await fetch("/api/tasks/doc", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      conversationId: "demo_conversation",
      userText,
      documentTemplateId: undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err && err.error ? err.error : `request failed: ${res.status}`);
  }
  return res.json();
}

function renderEvents(events) {
  const el = document.getElementById("events");
  if (!Array.isArray(events) || events.length === 0) {
    el.textContent = "未收到事件。";
    return;
  }
  el.innerHTML = events
    .map((e) => {
      const label = e.stepProgress && e.stepProgress.label ? e.stepProgress.label : "";
      const at = e.at ? new Date(e.at).toLocaleTimeString() : "";
      return `<div>${e.state || ""}${label ? " - " + label : ""}${at ? "（" + at + "）" : ""}</div>`;
    })
    .join("");
}

function renderDocument(docData) {
  const docEl = document.getElementById("doc");
  const metaEl = document.getElementById("docMeta");
  docEl.innerHTML = "";

  if (!docData || !docData.blocks || !Array.isArray(docData.topLevelBlockIds)) {
    docEl.textContent = "文档结构缺失。";
    metaEl.textContent = "";
    return;
  }

  metaEl.textContent = `docId: ${docData.docId}, version: ${docData.version}`;

  const blockNameMap = {
    title: "标题",
    summary: "摘要",
    requirements: "需求要点",
    conclusion: "关键结论",
  };

  for (const blockId of docData.topLevelBlockIds) {
    const b = docData.blocks[blockId];
    if (!b) continue;

    const blockTitle = blockNameMap[b.blockType] || b.blockType;
    const content = b.content || {};
    const wrapper = document.createElement("div");
    wrapper.className = "block";

    const title = document.createElement("div");
    title.className = "block-title";
    title.textContent = blockTitle;
    wrapper.appendChild(title);

    if (typeof content.text === "string") {
      const p = document.createElement("p");
      p.textContent = content.text;
      wrapper.appendChild(p);
    } else if (Array.isArray(content.bullets)) {
      const ul = document.createElement("ul");
      for (const item of content.bullets) {
        const li = document.createElement("li");
        li.textContent = String(item);
        ul.appendChild(li);
      }
      wrapper.appendChild(ul);
    } else {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "该块内容暂无可渲染字段。";
      wrapper.appendChild(p);
    }

    docEl.appendChild(wrapper);
  }
}

function setRaw(obj) {
  document.getElementById("raw").textContent = JSON.stringify(obj, null, 2);
}

function setInitial() {
  document.getElementById("events").textContent = "等待输入…";
  document.getElementById("doc").textContent = "";
  document.getElementById("docMeta").textContent = "";
  document.getElementById("raw").textContent = "";
}

document.getElementById("btn").addEventListener("click", async () => {
  setInitial();
  const userText = document.getElementById("userText").value;
  document.getElementById("events").textContent = "正在提交并生成…";
  try {
    const resp = await postDoc(userText);
    renderEvents(resp.events);
    renderDocument(resp.document);
    setRaw(resp);
  } catch (e) {
    document.getElementById("events").textContent = "失败：" + String(e && e.message ? e.message : e);
  }
});

