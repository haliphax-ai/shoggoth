type NoticeResolver = (key: string, vars?: Record<string, string>) => string;

let _resolver: NoticeResolver | undefined;

export function setNoticeResolver(resolver: NoticeResolver): void {
  _resolver = resolver;
}

export function daemonNotice(key: string, vars: Record<string, string> = {}): string {
  if (!_resolver) throw new Error("presentation: notice resolver not registered; call setNoticeResolver() at startup");
  return _resolver(key, vars);
}
