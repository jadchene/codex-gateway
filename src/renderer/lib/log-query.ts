import dayjs, { type Dayjs } from "dayjs";
import type { LogQuery } from "../../shared/contracts/logs";

export interface LogFilterValues {
  range: [Dayjs, Dayjs];
  accountId: string;
  upstreamId: string;
  clientModel: string;
  upstreamModel: string;
  sessionId: string;
  status: string;
  keyword: string;
  level: string;
  scope: string;
}

export const todayLogFilters = (): LogFilterValues => ({
  range: [dayjs().startOf("day"), dayjs().startOf("day")],
  accountId: "",
  upstreamId: "",
  clientModel: "",
  upstreamModel: "",
  sessionId: "",
  status: "",
  keyword: "",
  level: "",
  scope: ""
});

export const toLogQuery = (filters: LogFilterValues, page: number, pageSize: number): LogQuery => ({
  page,
  pageSize,
  startAt: filters.range[0].startOf("day").unix(),
  endAt: filters.range[1].add(1, "day").startOf("day").unix(),
  ...(filters.accountId ? { accountId: filters.accountId } : {}),
  ...(filters.upstreamId ? { upstreamId: filters.upstreamId } : {}),
  ...(filters.clientModel ? { clientModel: filters.clientModel } : {}),
  ...(filters.upstreamModel ? { upstreamModel: filters.upstreamModel } : {}),
  ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
  ...(filters.status ? { status: filters.status } : {}),
  ...(filters.keyword ? { keyword: filters.keyword } : {}),
  ...(filters.level ? { level: filters.level } : {}),
  ...(filters.scope ? { scope: filters.scope } : {})
});
