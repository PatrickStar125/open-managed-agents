// Locale plumbing for the blog — deliberately tiny, no i18n framework.
//
// Convention: a post at src/content/blog/zh-cn/<slug>.md gets collection
// id "zh-cn/<slug>" and routes to /blog/zh-cn/<slug>/. EN lives at the
// bare slug. Twins pair by the stripped slug. The next locale lands as
// one more entry in STRINGS plus a directory — nothing else changes.

export const ZH_PREFIX = "zh-cn/";

export type BlogLang = "en" | "zh-CN";

export function langForPostId(id: string): BlogLang {
  return id.startsWith(ZH_PREFIX) ? "zh-CN" : "en";
}

/** Strip the locale prefix so a zh post pairs with its EN twin slug. */
export function barePostId(id: string): string {
  return id.startsWith(ZH_PREFIX) ? id.slice(ZH_PREFIX.length) : id;
}

const STRINGS = {
  en: {
    home: "Home",
    blog: "Blog",
    minRead: "min read",
    relatedPosts: "Related posts",
    allPosts: "← All posts",
    rss: "Subscribe via RSS",
    updated: "updated",
    indexTitle: "Blog",
    indexDescription:
      "openma blog — posts about agents, infrastructure, and the people building them.",
    indexTagline:
      "Notes from building openma. Agent design, integrations, billing, the occasional postmortem.",
    indexEmpty: "No posts yet — first one's coming soon.",
    indexPath: "/blog/",
    indexSwitchLabel: "中文版 →",
    indexSwitchHref: "/blog/zh-cn/",
  },
  "zh-CN": {
    home: "首页",
    blog: "博客",
    minRead: "分钟阅读",
    relatedPosts: "相关文章",
    allPosts: "← 全部文章",
    rss: "RSS 订阅",
    updated: "更新于",
    indexTitle: "博客",
    indexDescription: "openma 博客 —— 关于智能体、基础设施以及构建它们的人。",
    indexTagline: "构建 openma 过程中的笔记。智能体设计、集成、计费，以及偶尔的事故复盘。",
    indexEmpty: "还没有文章 —— 第一篇即将发布。",
    indexPath: "/blog/zh-cn/",
    indexSwitchLabel: "English blog →",
    indexSwitchHref: "/blog/",
  },
} as const;

export function t(lang: BlogLang) {
  return STRINGS[lang];
}
