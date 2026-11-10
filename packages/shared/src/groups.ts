// Группы людей: чистые функции, общие для панели (предпросмотр «Применить ко всем») и
// веб-админки (пометка «отличается от группы», подстановка правил в форму).

import type { GroupRules, User } from './types.js';

export type GroupRuleKey = keyof GroupRules;

/** Порядок и подписи правил — так они показываются в админке и в предпросмотре. */
export const GROUP_RULE_LABELS: Record<GroupRuleKey, string> = {
  allowedServers: 'серверы',
  allowedProtocols: 'протоколы',
  allowedProxies: 'прокси',
  priorityAccess: 'приоритетный доступ',
  fullAccess: 'полный доступ (без защиты)',
  appOnly: 'только приложение NoVPN',
  deviceLimit: 'лимит устройств',
  trafficLimitGb: 'лимит трафика',
  resetPolicy: 'счёт лимита',
};

export const GROUP_RULE_KEYS = Object.keys(GROUP_RULE_LABELS) as GroupRuleKey[];

type UserRuleFields = Pick<
  User,
  'allowedServers' | 'allowedProtocols' | 'allowedProxies' | 'priorityAccess' | 'fullAccess' | 'appOnly' | 'deviceLimit' | 'trafficLimitGb' | 'resetPolicy'
>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** Правила с учётом «Только приложение NoVPN»: оно само означает «только Xray, без прокси». */
export function effectiveGroupRules(rules: GroupRules): GroupRules {
  if (rules.appOnly !== true) return rules;
  return { ...rules, allowedProtocols: ['xray'], allowedProxies: [] };
}

/** Какие правила группы у человека сейчас другие. Пустой список — «как в группе». */
export function groupDiff(u: Partial<UserRuleFields>, rawRules: GroupRules): GroupRuleKey[] {
  const rules = effectiveGroupRules(rawRules);
  const out: GroupRuleKey[] = [];
  for (const k of GROUP_RULE_KEYS) {
    const want = rules[k];
    if (want === undefined) continue;
    const have = u[k];
    let same: boolean;
    if (Array.isArray(want)) same = sameSet(want as string[], (have as string[] | undefined) ?? []);
    else if (typeof want === 'boolean') same = (have === true) === want;
    else if (k === 'resetPolicy') same = (have ?? 'never') === want;
    else same = (have ?? null) === (want ?? null);
    if (!same) out.push(k);
  }
  return out;
}

/** Есть ли у группы хоть одно правило. */
export function hasGroupRules(rules: GroupRules | null | undefined): boolean {
  return !!rules && GROUP_RULE_KEYS.some((k) => rules[k] !== undefined);
}
