// Выбор адаптера. VITE_USE_MOCK=true → mock (без backend), иначе real HTTP API.
// Переключение mock ↔ real не требует изменений в компонентах.

import type { ApiClient } from './types';
import { mockApi } from './mock/mockApi';
import { httpApi } from './http/httpApi';

const useMock = import.meta.env.VITE_USE_MOCK === 'true';

export const api: ApiClient = useMock ? mockApi : httpApi;
export const IS_MOCK = useMock;
export type { ApiClient } from './types';
