// Объявления в приложениях: администратор пишет сообщение, приложение NoVPN показывает его
// один раз (а Happ — в шапке подписки). Нужны, чтобы без рассылок сказать «обновитесь»:
// сообщение приходит с панели, она в России — доходит и без работающего VPN.

import { useEffect, useState } from 'react';
import type { Announcement } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Chip, Field, Panel, Toggle } from '../components/ui';

const AUDIENCE: Array<{ key: Announcement['audience']; label: string }> = [
  { key: 'all', label: 'Всем' },
  { key: 'android', label: 'NoVPN Android' },
  { key: 'windows', label: 'NoVPN Windows' },
  { key: 'happ', label: 'Happ' },
];

const audienceLabel = (a: Announcement): string => {
  const base = AUDIENCE.find((x) => x.key === a.audience)?.label ?? a.audience;
  return a.belowVersion ? `${base} ниже ${a.belowVersion}` : base;
};

export function AnnouncementsPanel() {
  const { showToast, showConfirm } = useApp();
  const [list, setList] = useState<Announcement[] | null>(null);
  const [text, setText] = useState('');
  const [audience, setAudience] = useState<Announcement['audience']>('all');
  const [below, setBelow] = useState('');
  const [update, setUpdate] = useState(false);
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .listAnnouncements()
      .then((r) => setList(r.announcements))
      .catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);

  const versioned = audience === 'android' || audience === 'windows';
  const create = async () => {
    setBusy(true);
    try {
      await api.createAnnouncement({
        text: text.trim(),
        audience,
        belowVersion: versioned && below.trim() ? below.trim() : null,
        update: audience !== 'happ' && update,
        days: days.trim() ? Number(days) : null,
      });
      setText('');
      setBelow('');
      setUpdate(false);
      showToast('Объявление отправлено — приложения покажут его при следующей проверке');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Объявления в приложениях">
      <div className="body small muted" style={{ marginBottom: 10 }}>
        Сообщение людям прямо в приложении: NoVPN покажет его один раз окном (с кнопкой
        «Обновить», если нужно), Happ — в шапке подписки. Приходит с панели, поэтому доходит
        и без работающего VPN. Видят его версии NoVPN начиная с Android 0.2.15 и Windows 0.3.39 —
        тем, кто на старых, напишите в Telegram.
      </div>
      <Field label="Текст">
        <textarea
          className="textarea"
          style={{ minHeight: 80 }}
          maxLength={500}
          placeholder="Например: вышла новая версия — обновитесь, на старой будут сбои с подключением."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Field label="Кому">
        <div className="chip-row">
          {AUDIENCE.map((a) => (
            <Chip key={a.key} label={a.label} active={audience === a.key} onClick={() => setAudience(a.key)} />
          ))}
        </div>
      </Field>
      {versioned ? (
        <Field label="Только версиям ниже (необязательно)" hint="Например 0.2.15 — увидят те, у кого версия старше не обновлена.">
          <input className="input mono" style={{ maxWidth: 160 }} placeholder="0.2.15" value={below} onChange={(e) => setBelow(e.target.value.replace(/[^\d.]/g, ''))} />
        </Field>
      ) : null}
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {audience !== 'happ' ? (
          <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <Toggle on={update} onChange={setUpdate} ariaLabel="Кнопка «Обновить»" />
            <span className="small">Кнопка «Обновить»</span>
          </label>
        ) : null}
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="small">Показывать дней</span>
          <input className="input" inputMode="numeric" style={{ width: 70 }} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={() => void create()}>
          {busy ? 'Отправляем…' : 'Отправить'}
        </button>
      </div>
      {list && list.length > 0 ? (
        list.map((a) => (
          <div key={a.id} className="divide-row" style={{ alignItems: 'flex-start' }}>
            <span className="small" style={{ flex: 1 }}>
              <span className="muted">
                {audienceLabel(a)}
                {a.update ? ' · кнопка «Обновить»' : ''}
                {a.expiresAt ? ` · до ${new Date(a.expiresAt).toLocaleDateString('ru-RU')}` : ''}
                {a.expiresAt && new Date(a.expiresAt) < new Date() ? ' · истекло' : ''}
              </span>
              <br />
              {a.text}
            </span>
            <button
              className="btn btn-outline btn-sm"
              onClick={() =>
                showConfirm({
                  title: 'Убрать объявление?',
                  text: 'Приложения перестанут его показывать. Кто уже видел — увидел.',
                  confirmLabel: 'Убрать',
                  danger: true,
                  onConfirm: async () => {
                    await api.deleteAnnouncement(a.id);
                    await load();
                  },
                })
              }
            >
              Убрать
            </button>
          </div>
        ))
      ) : list ? (
        <span className="small muted">Объявлений нет</span>
      ) : null}
    </Panel>
  );
}
