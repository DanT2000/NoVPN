// Группы людей (1.7.0): правила группы и «Применить ко всем в группе». Группа — это
// прежняя «категория» человека; правила подставляются в форму, когда человека заводят в
// группу, и применяются ко всем участникам кнопкой — с предпросмотром, кому что изменится.

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { GroupApplyPreview, GroupRules, ProxyType, Server, User, UserGroup } from '@novpn/shared';
import { GROUP_RULE_LABELS, effectiveGroupRules, groupDiff, hasGroupRules } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Chip, EmptyState, Panel, ScreenHeader, Toggle } from '../components/ui';
import { plural } from '../lib/format';

const PROXY_LABELS: Record<ProxyType, string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' };

/** Коротко о правилах группы — для списка групп. */
export function rulesSummary(rules: GroupRules, servers: Server[]): string {
  const r = effectiveGroupRules(rules);
  const parts: string[] = [];
  if (r.appOnly) parts.push('только NoVPN');
  if (r.allowedServers) parts.push(r.allowedServers.map((id) => servers.find((s) => s.id === id)?.name ?? '?').join(', ') || 'без серверов');
  if (r.allowedProtocols && !r.appOnly) parts.push(r.allowedProtocols.map((p) => (p === 'xray' ? 'Xray' : 'Amnezia')).join(' + ') || 'без VPN');
  if (r.allowedProxies && !r.appOnly) parts.push(r.allowedProxies.length ? `прокси ${r.allowedProxies.map((p) => PROXY_LABELS[p]).join('/')}` : 'без прокси');
  if (r.priorityAccess !== undefined) parts.push(r.priorityAccess ? 'приоритетный' : 'без приоритетного');
  if (r.fullAccess !== undefined) parts.push(r.fullAccess ? 'полный доступ' : 'с защитой');
  if (r.deviceLimit !== undefined) parts.push(`устройств: ${r.deviceLimit ?? '∞'}`);
  if (r.trafficLimitGb !== undefined) parts.push(`трафик: ${r.trafficLimitGb == null ? '∞' : `${r.trafficLimitGb} ГБ`}${r.resetPolicy === 'monthly' ? '/мес' : ''}`);
  else if (r.resetPolicy) parts.push(r.resetPolicy === 'monthly' ? 'лимит в месяц' : 'лимит за всё время');
  return parts.join(' · ') || 'правил нет — у каждого своё';
}

export function Groups() {
  const { data, nav, goAdmin, showToast, reload } = useApp();
  const [sel, setSel] = useState<string | null>(nav.params.group ?? null);
  const [newName, setNewName] = useState<string | null>(null);
  if (!data) return null;
  const groups = data.groups ?? [];
  const current = groups.find((g) => g.name === sel) ?? groups[0] ?? null;

  const createGroup = async () => {
    const n = (newName ?? '').trim();
    if (!n) return;
    try {
      await api.createGroup(n);
      await reload();
      setSel(n);
      setNewName(null);
      showToast(`Группа «${n}» создана`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось создать группу');
    }
  };

  return (
    <>
      <ScreenHeader
        eyebrow="Люди"
        title="Группы"
        right={
          newName === null ? (
            <button className="btn btn-primary" onClick={() => setNewName('')}>
              + Новая группа
            </button>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <input className="input" autoFocus placeholder="Название" value={newName} maxLength={40} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void createGroup()} />
              <button className="btn btn-primary btn-sm" onClick={() => void createGroup()}>Создать</button>
              <button className="btn btn-outline btn-sm" onClick={() => setNewName(null)}>Отмена</button>
            </div>
          )
        }
      />
      <div className="body small muted" style={{ marginBottom: 14 }}>
        Группа задаёт правила своим людям: серверы, протоколы, полный и приоритетный доступ, лимиты,
        «только приложение NoVPN». Правило, которое группа не задаёт, остаётся у каждого своим. Новый
        человек в группе получает её правила сразу (их подставит форма); тем, кто уже в группе, — кнопкой
        «Применить ко всем». Отдельного человека по-прежнему можно поправить в его карточке.
      </div>

      {groups.length === 0 ? (
        <EmptyState title="Групп пока нет" text="Создайте группу или укажите группу в карточке человека." />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="chip-row" style={{ flexWrap: 'wrap' }}>
            {groups.map((g) => {
              const differ = membersOf(data.users, g.name).filter((u) => groupDiff(u, g.rules).length > 0).length;
              return (
                <Chip
                  key={g.name}
                  active={current?.name === g.name}
                  onClick={() => setSel(g.name)}
                  label={
                    <span>
                      {g.name} <span className="muted">· {g.members}</span>
                      {hasGroupRules(g.rules) && differ ? <span style={{ color: 'var(--amber-fg)' }}> · {differ} ≠</span> : null}
                    </span>
                  }
                />
              );
            })}
          </div>
          {current ? <GroupEditor key={`${current.name}|${JSON.stringify(current.rules)}`} group={current} onRenamed={setSel} goUser={(id) => goAdmin('user-card', { userId: id })} /> : null}
        </div>
      )}
    </>
  );
}

function membersOf(users: User[], name: string): User[] {
  return users.filter((u) => (u.category ?? '') === name);
}

type Mode = 'unset' | 'set';

function GroupEditor({ group, onRenamed, goUser }: { group: UserGroup; onRenamed: (n: string) => void; goUser: (id: string) => void }) {
  const { data, showToast, showConfirm, reload } = useApp();
  const servers = data?.servers ?? [];
  const members = membersOf(data?.users ?? [], group.name);
  const [draft, setDraft] = useState<GroupRules>({ ...group.rules });
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<GroupApplyPreview | null>(null);
  const [rename, setRename] = useState(group.name);
  const [trafRaw, setTrafRaw] = useState(group.rules.trafficLimitGb != null ? String(group.rules.trafficLimitGb) : '');
  const [devRaw, setDevRaw] = useState(group.rules.deviceLimit != null ? String(group.rules.deviceLimit) : '');
  const dirty = JSON.stringify(draft) !== JSON.stringify(group.rules);
  const eff = effectiveGroupRules(draft);

  const set = <K extends keyof GroupRules>(k: K, v: GroupRules[K] | undefined) => {
    setPreview(null);
    setDraft((d) => {
      const n = { ...d };
      if (v === undefined) delete n[k];
      else n[k] = v;
      return n;
    });
  };
  const mode = (k: keyof GroupRules): Mode => (draft[k] === undefined ? 'unset' : 'set');
  const toggleIn = <T extends string>(arr: T[] | undefined, x: T): T[] => {
    const a = arr ?? [];
    return a.includes(x) ? a.filter((y) => y !== x) : [...a, x];
  };

  const save = async () => {
    setBusy('save');
    try {
      await api.saveGroup(group.name, { rules: draft });
      await reload();
      showToast('Правила группы сохранены. Людям — кнопкой «Применить ко всем»');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(null);
    }
  };
  const askPreview = async () => {
    if (!hasGroupRules(draft)) return showToast('Задайте хотя бы одно правило');
    setBusy('preview');
    try {
      setPreview(await api.previewGroup(group.name, draft));
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось посчитать');
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    setBusy('apply');
    try {
      const r = await api.applyGroup(group.name, draft);
      await reload();
      setPreview(null);
      showToast(
        `Применено: изменено у ${r.changed} ${plural(r.changed, 'человека', 'человек', 'человек')}` +
          (r.revoked ? `, снято конфигов: ${r.revoked}` : '') +
          (r.failed.length ? `. Не применилось: ${r.failed.join('; ')}` : ''),
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось применить');
    } finally {
      setBusy(null);
    }
  };
  const doRename = async () => {
    const n = rename.trim();
    if (!n || n === group.name) return;
    try {
      await api.saveGroup(group.name, { newName: n });
      await reload();
      onRenamed(n);
      showToast(`Группа переименована в «${n}»`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось переименовать');
    }
  };
  const doDelete = () =>
    showConfirm({
      title: `Удалить группу «${group.name}»?`,
      text: 'Удалятся только правила группы. Людей в ней нет.',
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: async () => {
        await api.deleteGroup(group.name);
        await reload();
        onRenamed('');
        showToast('Группа удалена');
      },
    });

  const changing = preview?.people.filter((p) => p.changes.length) ?? [];
  const revokeTotal = changing.reduce((n, p) => n + p.revokeConfigs, 0);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Panel
        title={`Правила группы «${group.name}»`}
        extra={
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-outline btn-sm" disabled={!dirty || !!busy} onClick={() => void save()}>
              {busy === 'save' ? 'Сохраняем…' : 'Сохранить правила'}
            </button>
            <button className="btn btn-primary btn-sm" disabled={!members.length || !!busy} onClick={() => void askPreview()}>
              {busy === 'preview' ? 'Считаем…' : `Применить ко всем (${members.length})`}
            </button>
          </div>
        }
      >
        <RuleRow label="Разрешённые серверы" on={mode('allowedServers') === 'set'} onToggle={(v) => set('allowedServers', v ? [...servers.map((s) => s.id)] : undefined)}>
          <div className="chip-row" style={{ flexWrap: 'wrap' }}>
            {servers.map((s) => (
              <Chip key={s.id} size="sm" label={`${s.flagEmoji ? `${s.flagEmoji} ` : ''}${s.name}`} active={draft.allowedServers?.includes(s.id)} onClick={() => set('allowedServers', toggleIn(draft.allowedServers, s.id))} />
            ))}
          </div>
        </RuleRow>

        <RuleRow
          label="Только приложение NoVPN"
          hint="Amnezia и прокси не выдаются (выданные снимутся), а Happ и другие чужие приложения вместо серверов получают сообщение «Подключайтесь через приложение NoVPN». Тем, у кого айфон и Happ, не ставьте."
          on={mode('appOnly') === 'set'}
          onToggle={(v) => set('appOnly', v ? true : undefined)}
        >
          <OnOff value={draft.appOnly === true} onChange={(v) => set('appOnly', v)} />
        </RuleRow>

        <RuleRow label="VPN-протоколы" on={mode('allowedProtocols') === 'set' || eff.appOnly === true} disabled={eff.appOnly === true} onToggle={(v) => set('allowedProtocols', v ? ['xray'] : undefined)}>
          <div className="chip-row">
            {(['xray', 'amneziawg'] as const).map((p) => (
              <Chip key={p} size="sm" label={p === 'xray' ? 'Xray' : 'Amnezia'} disabled={eff.appOnly === true} active={eff.allowedProtocols?.includes(p)} onClick={() => set('allowedProtocols', toggleIn(draft.allowedProtocols, p))} />
            ))}
          </div>
        </RuleRow>

        <RuleRow label="Прокси" on={mode('allowedProxies') === 'set' || eff.appOnly === true} disabled={eff.appOnly === true} onToggle={(v) => set('allowedProxies', v ? [] : undefined)}>
          <div className="chip-row">
            {(['http', 'https', 'socks5'] as const).map((p) => (
              <Chip key={p} size="sm" label={PROXY_LABELS[p]} disabled={eff.appOnly === true} active={eff.allowedProxies?.includes(p)} onClick={() => set('allowedProxies', toggleIn(draft.allowedProxies, p))} />
            ))}
          </div>
        </RuleRow>

        <RuleRow label="Приоритетный доступ" hint="Общий резервный пул NoVPN." on={mode('priorityAccess') === 'set'} onToggle={(v) => set('priorityAccess', v ? true : undefined)}>
          <OnOff value={draft.priorityAccess === true} onChange={(v) => set('priorityAccess', v)} />
        </RuleRow>

        <RuleRow label="Полный доступ (без защиты)" hint="Серверы не режут российские сервисы, полный режим — в любом приложении." on={mode('fullAccess') === 'set'} onToggle={(v) => set('fullAccess', v ? false : undefined)}>
          <OnOff value={draft.fullAccess === true} onChange={(v) => set('fullAccess', v)} />
        </RuleRow>

        <RuleRow label="Лимит устройств (Amnezia)" on={mode('deviceLimit') === 'set'} onToggle={(v) => set('deviceLimit', v ? null : undefined)}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Chip size="sm" label="∞" active={draft.deviceLimit === null} onClick={() => { setDevRaw(''); set('deviceLimit', null); }} />
            <input
              className="input" inputMode="numeric" placeholder="число" style={{ maxWidth: 110 }} value={devRaw}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '');
                setDevRaw(v);
                set('deviceLimit', v ? parseInt(v, 10) : null);
              }}
            />
          </div>
        </RuleRow>

        <RuleRow label="Лимит трафика" on={mode('trafficLimitGb') === 'set'} onToggle={(v) => set('trafficLimitGb', v ? null : undefined)}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Chip size="sm" label="∞" active={draft.trafficLimitGb === null} onClick={() => { setTrafRaw(''); set('trafficLimitGb', null); }} />
            <input
              className="input" inputMode="decimal" placeholder="ГБ" style={{ maxWidth: 110 }} value={trafRaw}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.,]/g, '');
                setTrafRaw(v);
                const n = parseFloat(v.replace(',', '.'));
                set('trafficLimitGb', Number.isFinite(n) && n > 0 ? n : null);
              }}
            />
          </div>
        </RuleRow>

        <RuleRow label="Счёт лимита трафика" on={mode('resetPolicy') === 'set'} onToggle={(v) => set('resetPolicy', v ? 'monthly' : undefined)}>
          <div className="chip-row">
            <Chip size="sm" label="За всё время" active={draft.resetPolicy === 'never'} onClick={() => set('resetPolicy', 'never')} />
            <Chip size="sm" label="В месяц" active={draft.resetPolicy === 'monthly'} onClick={() => set('resetPolicy', 'monthly')} />
          </div>
        </RuleRow>

        {preview ? (
          <div className="notice small" style={{ marginTop: 12 }}>
            {changing.length === 0 ? (
              <div>У всех {members.length} уже так — менять нечего.</div>
            ) : (
              <>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Изменится у {changing.length} из {members.length}
                  {revokeTotal ? `, снимется конфигов: ${revokeTotal}` : ''}:
                </div>
                <ul style={{ margin: '0 0 8px 18px', padding: 0 }}>
                  {changing.map((p) => (
                    <li key={p.userId}>
                      <b>{p.name}</b> — {p.changes.join(', ')}
                      {p.revokeConfigs ? <span style={{ color: 'var(--amber-fg)' }}> · снимется {p.revokeConfigs} {plural(p.revokeConfigs, 'конфиг', 'конфига', 'конфигов')}</span> : null}
                    </li>
                  ))}
                </ul>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void apply()}>
                    {busy === 'apply' ? 'Применяем…' : 'Подтвердить'}
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => setPreview(null)}>Отмена</button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </Panel>

      <Panel title={`Люди в группе (${members.length})`}>
        {members.length === 0 ? (
          <span className="small muted">В группе пока никого. Группу человеку задают в его карточке.</span>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {members.map((u) => {
              const diff = groupDiff(u, group.rules);
              return (
                <button
                  key={u.id}
                  type="button"
                  className="divide-row"
                  onClick={() => goUser(u.id)}
                  style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--border-inner)', cursor: 'pointer', textAlign: 'left' }}
                >
                  <span style={{ fontWeight: 600 }}>{u.name}</span>
                  <span className="small" style={{ color: diff.length ? 'var(--amber-fg)' : 'var(--text-muted)' }}>
                    {!hasGroupRules(group.rules) ? '' : diff.length ? `отличается: ${diff.map((k) => GROUP_RULE_LABELS[k]).join(', ')}` : 'как в группе'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Группа">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ maxWidth: 260 }} value={rename} maxLength={40} onChange={(e) => setRename(e.target.value)} />
          <button className="btn btn-outline btn-sm" disabled={!rename.trim() || rename.trim() === group.name} onClick={() => void doRename()}>
            Переименовать
          </button>
          <button className="btn btn-danger-outline btn-sm" disabled={members.length > 0} title={members.length ? 'Сначала переведите людей в другую группу' : ''} onClick={doDelete}>
            Удалить группу
          </button>
        </div>
      </Panel>
    </div>
  );
}

/** Значение правила «вкл/выкл» — кнопками, чтобы не путать со строчным «задаёт группа». */
function OnOff({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="chip-row">
      <Chip size="sm" label="Включено" active={value} onClick={() => onChange(true)} />
      <Chip size="sm" label="Выключено" active={!value} onClick={() => onChange(false)} />
    </div>
  );
}

/** Строка правила: «задаёт группа» слева, значение справа (пока не задаёт — значения нет). */
function RuleRow({
  label, hint, on, onToggle, disabled, children,
}: {
  label: string; hint?: string; on: boolean; onToggle: (v: boolean) => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <div className="field" style={{ borderBottom: '1px solid var(--border-inner)', paddingBottom: 10, marginBottom: 10 }}>
      <label className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'space-between', cursor: disabled ? 'default' : 'pointer' }}>
        <span>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span className="small muted" style={{ display: 'block', marginTop: 2 }}>
            {disabled ? 'задаёт правило «Только приложение NoVPN»' : on ? 'задаёт группа' : 'не задаёт — у каждого своё'}
            {hint && on ? ` · ${hint}` : ''}
          </span>
        </span>
        {disabled ? null : <Toggle on={on} onChange={onToggle} ariaLabel={`Группа задаёт: ${label}`} />}
      </label>
      {on ? <div style={{ marginTop: 8 }}>{children}</div> : null}
    </div>
  );
}
