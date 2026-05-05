const SLIDE_NS = "http://www.larkoffice.com/sml/2.0";

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function slideOpen() {
  return `<slide xmlns="${SLIDE_NS}">`;
}

function slideBg(fillColorAttr) {
  return `<style><fill><fillColor color="${fillColorAttr}"/></fill></style>`;
}

function bulletsToBody(safeBullets) {
  const list = safeBullets.map((x) => `<li><p>${x}</p></li>`).join("");
  return list ? `<ul>${list}</ul>` : `<p>（暂无要点）</p>`;
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string[]} opts.bullets
 * @param {"cover"|"content"|"closing"} opts.role
 * @param {object} opts.visualTheme
 */
function buildSlideXml({ title, bullets, role, visualTheme }) {
  const t = visualTheme && typeof visualTheme === "object" ? visualTheme : {};
  const safeTitle = escapeXml(title || "未命名");
  const rawBullets = Array.isArray(bullets) ? bullets : [];
  const safeBullets = rawBullets.map((x) => escapeXml(x)).filter(Boolean).slice(0, 6);
  const accent = t.accentRgb || "rgb(59,130,246)";
  const onDark = t.onDark || "rgb(255,255,255)";
  const onLightTitle = t.onLightTitle || "rgb(15,23,42)";
  const onLightBody = t.onLightBody || "rgb(30,41,59)";

  if (role === "cover") {
    const bg = t.coverBg || t.contentBg || "rgb(248,250,252)";
    const bodyInner = bulletsToBody(safeBullets);
    return (
      slideOpen() +
      slideBg(bg) +
      `<data>` +
      `<shape type="text" topLeftX="80" topLeftY="140" width="800" height="120">` +
      `<content textType="title" textAlign="center" color="${onDark}"><p>${safeTitle}</p></content>` +
      `</shape>` +
      `<shape type="text" topLeftX="100" topLeftY="280" width="760" height="220">` +
      `<content textType="body" textAlign="center" color="${onDark}">${bodyInner}</content>` +
      `</shape>` +
      `</data>` +
      `</slide>`
    );
  }

  if (role === "closing") {
    const bg = t.closingBg || t.coverBg || t.contentBg || "rgb(248,250,252)";
    const bodyInner = bulletsToBody(safeBullets);
    return (
      slideOpen() +
      slideBg(bg) +
      `<data>` +
      `<shape type="text" topLeftX="80" topLeftY="160" width="800" height="100">` +
      `<content textType="title" textAlign="center" color="${onDark}"><p>${safeTitle}</p></content>` +
      `</shape>` +
      `<shape type="text" topLeftX="100" topLeftY="280" width="760" height="200">` +
      `<content textType="body" textAlign="center" color="${onDark}">${bodyInner}</content>` +
      `</shape>` +
      `</data>` +
      `</slide>`
    );
  }

  // content
  const pageBg = t.contentBg || "rgb(248,250,252)";
  const bodyInner = bulletsToBody(safeBullets);
  return (
    slideOpen() +
    slideBg(pageBg) +
    `<data>` +
    `<shape type="rect" topLeftX="0" topLeftY="0" width="960" height="14">` +
    `<fill><fillColor color="${accent}"/></fill>` +
    `</shape>` +
    `<shape type="rect" topLeftX="72" topLeftY="100" width="6" height="360">` +
    `<fill><fillColor color="${accent}"/></fill>` +
    `</shape>` +
    `<shape type="text" topLeftX="96" topLeftY="96" width="784" height="88">` +
    `<content textType="title" color="${onLightTitle}"><p>${safeTitle}</p></content>` +
    `</shape>` +
    `<shape type="text" topLeftX="96" topLeftY="196" width="784" height="300">` +
    `<content textType="body" color="${onLightBody}">${bodyInner}</content>` +
    `</shape>` +
    `</data>` +
    `</slide>`
  );
}

function slideRoleForIndex(i, total) {
  if (total <= 1) return "cover";
  if (i === 0) return "cover";
  if (i === total - 1) return "closing";
  return "content";
}

module.exports = { buildSlideXml, slideRoleForIndex, escapeXml };
