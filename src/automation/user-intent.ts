import { InvalidTaskStateError } from "../domain/errors.js";

export type UserIntentName = "discuss" | "status" | "continue" | "delivery" | "close" | "rollback" | "sync" | "establish";
export type UserIntentRisk = "read-only" | "bounded-mutation" | "destructive" | "external-read" | "setup";
export type UserIntentRiskLevel = 0 | 1 | 2 | 3;
export type UserIntentEndpoint = "discussion" | "status" | "continuation" | "review-ready-pr" | "local-change" | "close" | "rollback" | "sync" | "establish";

export interface UserIntent {
  readonly text: string;
  readonly intent: UserIntentName;
  readonly project: string | null;
  readonly resumeExistingTask: boolean;
  readonly expectedEndpoint: UserIntentEndpoint;
  readonly risk: UserIntentRisk;
  readonly riskLevel: UserIntentRiskLevel;
  readonly certainty: "clear" | "ambiguous";
}

function projectFromRequest(text: string): string | null {
  const english = /(?:continue|resume)\s+(?:the\s+)?(.+?)(?=\s+(?:and|then|but|fix|change|implement|create|open|publish)\b|[,，。！？?]|$)/iu.exec(text);
  if (english?.[1] !== undefined) return english[1].trim();
  const chinese = /(?:继续|接着|恢复)\s*(?:修复|修改|改成|实现)?\s*([A-Za-z0-9][A-Za-z0-9._/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._/-]*){0,5})/iu.exec(text);
  if (chinese?.[1] !== undefined) return chinese[1].trim();
  const previous = /(?:继续|接着|恢复)\s*(?:上次|之前)?\s*([A-Za-z0-9][A-Za-z0-9._/-]*)(?=\s*(?:的工作|工作|并|，|,|。|$))/iu.exec(text);
  if (previous?.[1] !== undefined) return previous[1].trim();
  const statusProject = /(?:查看|检查|查询)\s+([A-Za-z0-9][A-Za-z0-9._/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._/-]*){0,5})(?=\s+(?:当前|目前|状态|进展))/iu.exec(text);
  if (statusProject?.[1] !== undefined) return statusProject[1].trim();
  const progressProject = /(?:现在|当前|目前)\s+([A-Za-z0-9][A-Za-z0-9._/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._/-]*){0,5})(?=\s+(?:做到哪(?:里)?|到哪(?:里)?|进展))/iu.exec(text);
  if (progressProject?.[1] !== undefined) return progressProject[1].trim();
  const englishProgressProject = /(?:what(?:'s| is)|how(?:'s| is))\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9._/-]*(?:'s)?)\s+(?:status|progress)\b/iu.exec(text);
  if (englishProgressProject?.[1] !== undefined && !/^(?:current|project)$/iu.test(englishProgressProject[1])) return englishProgressProject[1].replace(/'s$/iu, "").trim();
  const updateProject = /(?:give\s+me\s+an?\s+update\s+(?:on|about|regarding)|update\s+me\s+(?:on|about|regarding))\s+([A-Za-z0-9][A-Za-z0-9._/-]*)\b/iu.exec(text);
  if (updateProject?.[1] !== undefined && !/^(?:the|project)$/iu.test(updateProject[1])) return updateProject[1].trim();
  const labeled = /(?:项目|project|建立|初始化)\s+([A-Za-z0-9][A-Za-z0-9._/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._/-]*){0,5})/iu.exec(text);
  const labeledProject = labeled?.[1]?.trim();
  return labeledProject !== undefined && !/^(?:status|progress)$/iu.test(labeledProject) ? labeledProject : null;
}

function hasQuestionShape(text: string): boolean {
  return /[?？]|\b(?:is|are|should|could|would|whether|what|why|how)\b|(?:是不是|是否|应该|能不能|怎么|为什么)/iu.test(text);
}

function hasStatusQuestionShape(text: string): boolean {
  return /^(?:what(?:'s| is)|how(?:'s| is))\s+(?:the\s+)?(?:(?:current|project)\s+)?(?:[A-Za-z0-9][A-Za-z0-9._/-]*(?:'s)?\s+)?(?:status|progress)\b/iu.test(text)
    || /(?:现在|当前|目前)\s*(?:[A-Za-z0-9][A-Za-z0-9._/-]*\s*)?(?:状态|进展)(?:怎么样|如何|到哪(?:里)?|到哪里)?/u.test(text)
    || /^(?:give\s+me\s+an?\s+update\s+(?:on|about|regarding)|update\s+me\s+(?:on|about|regarding))\b/iu.test(text);
}

function hasMutationShape(text: string): boolean {
  return /\b(?:fix|change|implement|build|modify|update|deliver)\b/iu.test(text)
    || /(?:修复|修掉|修好|修改|改成|实现|构建|更新|交付|按.+改)/u.test(text)
    || /\bcreate\s+(?:a|an)\s+(?:local\s+)?(?:parser|helper)\b/iu.test(text)
    || /创建(?:一个|一份)?\s*(?:CLI\s+)?(?:helper|解析器|辅助工具)\b/iu.test(text);
}

function hasPublicationShape(text: string): boolean {
  if (/^\s*(?:please\s+)?(?:explain|describe|clarify|discuss|解释|说明|讨论)/iu.test(text)) return false;
  return /^\s*push\s*$/iu.test(text)
    || /^\s*pull\s+request\s*$/iu.test(text)
    || /^\s*推送分支\s*$/u.test(text)
    || /\bcommit\s+and\s+push\b/iu.test(text)
    || /\b(?:commit|push|publish)\s+(?:(?:and|then)\s+)?(?:this|the|that|these|it|change|changes|code|update|modification|work|branch|repo|repository)\b/iu.test(text)
    || /\b(?:create|open)\s+(?:a\s+)?(?:PR|pull\s+request)\b/iu.test(text)
    || /\breview[- ]ready(?:\s+PR)?\b/iu.test(text)
    || /(?:提交|推送|发布)(?:并|和)?(?:提交|推送|发布)?(?:这个|该|此)?(?:修改|改动|变更|代码|更新)(?:并|和)?(?:提\s*(?:PR|pull\s+request)|创建(?:\s*(?:PR|pull\s+request)|合并请求))?/iu.test(text)
    || /(?:提\s*(?:PR|pull\s+request)|创建(?:\s*(?:PR|pull\s+request)|合并请求))/iu.test(text);
}

function hasContinueSignal(text: string): boolean {
  return /^(?:continue|resume)\b|^(?:继续|接着|恢复)/iu.test(text.trim())
    || /(?:continue|resume)\s+(?:the\s+)?/iu.test(text)
    || /(?:继续|接着|恢复)\s*(?:修复|fix|改|change|implement|实现)/iu.test(text);
}

function makeIntent(
  text: string,
  intent: UserIntentName,
  project: string | null,
  resumeExistingTask: boolean,
  expectedEndpoint: UserIntentEndpoint,
  risk: UserIntentRisk,
  riskLevel: UserIntentRiskLevel,
  certainty: UserIntent["certainty"] = "clear",
): UserIntent {
  return { text, intent, project, resumeExistingTask, expectedEndpoint, risk, riskLevel, certainty };
}

export function classifyUserIntent(input: string): UserIntent {
  if (typeof input !== "string") throw new InvalidTaskStateError("user request must be a string");
  const text = input.trim();
  if (text.length === 0) throw new InvalidTaskStateError("user request must not be empty");

  if (/(?:做到哪(?:里)?|到哪(?:里)?|进展到哪|当前进展)/u.test(text)) {
    return makeIntent(text, "status", projectFromRequest(text), false, "status", "read-only", 0);
  }
  if (/^(?:今天)?\s*(?:先)?(?:做到这里|到这里|暂时到这里)|(?:状态保存好|保存好状态)|(?:任务)?结束了|收尾/u.test(text)) {
    return makeIntent(text, "close", projectFromRequest(text), false, "close", "bounded-mutation", 1);
  }
  if (/(?:恢复之前状态|恢复先前状态|恢复到修改前|回到之前状态)/u.test(text)) {
    return makeIntent(text, "rollback", projectFromRequest(text), false, "rollback", "destructive", 3);
  }
  if (hasStatusQuestionShape(text)) {
    return makeIntent(text, "status", projectFromRequest(text), false, "status", "read-only", 0);
  }
  if (hasQuestionShape(text)) return makeIntent(text, "discuss", null, false, "discussion", "read-only", 0);
  if (/^(?:@D-AI\s+)?(?:status|state|check\s+(?:the\s+)?(?:status|state)|查看状态|检查(?:一下)?当前状态|进展)/iu.test(text)
    || /^(?:查看|检查|查询).{0,24}(?:状态|进展)/iu.test(text)
    || /(?:当前状态|目前状态)/iu.test(text)) {
    return makeIntent(text, "status", projectFromRequest(text), false, "status", "read-only", 0);
  }
  if (/^(?:@D-AI\s+)?(?:rollback|revert|回滚|撤销|恢复刚才)/iu.test(text)) {
    return makeIntent(text, "rollback", projectFromRequest(text), false, "rollback", "destructive", 3);
  }
  if (/^(?:@D-AI\s+)?(?:close|finish|end|关闭|结束|收尾|完成当前任务)/iu.test(text)) {
    return makeIntent(text, "close", projectFromRequest(text), false, "close", "bounded-mutation", 1);
  }
  if (/^(?:@D-AI\s+)?(?:sync|synchronize|同步|刷新 canonical|刷新主线)/iu.test(text)) {
    return makeIntent(text, "sync", projectFromRequest(text), false, "sync", "external-read", 0);
  }
  if (/^(?:@D-AI\s+)?(?:establish|setup|initialize)/iu.test(text) || /(?:建立|初始化)/u.test(text)) {
    return makeIntent(text, "establish", projectFromRequest(text), false, "establish", "setup", 1);
  }

  const resumeExistingTask = hasContinueSignal(text);
  const publicationRequested = hasPublicationShape(text);
  if (publicationRequested || hasMutationShape(text)) {
    return makeIntent(
      text,
      "delivery",
      projectFromRequest(text),
      resumeExistingTask,
      publicationRequested ? "review-ready-pr" : "local-change",
      "bounded-mutation",
      publicationRequested ? 2 : 1,
    );
  }
  if (resumeExistingTask || /^(?:continue|resume)\b|^(?:继续|接着|恢复)/iu.test(text)) {
    return makeIntent(text, "continue", projectFromRequest(text), true, "continuation", "bounded-mutation", 1);
  }
  return makeIntent(text, "discuss", projectFromRequest(text), false, "discussion", "read-only", 0, "ambiguous");
}
