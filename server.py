#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
회의실 예약 로컬 서버 (Python 표준 라이브러리만 사용, 설치 불필요)

  python3 server.py        # http://localhost:5173

플로우 API 키를 서버측(.env)에 보관하고 플로우 REST API 를 프록시한다.
프론트엔드(public/)를 서빙하고 /api/* 로 캘린더 읽기/쓰기를 중계한다.

플로우 REST API (https://api.flow.team/v1)
  GET  /calendars              접근 가능한 캘린더 목록
  GET  /calendars/events       기간 내 일정 조회 (startDateTime/endDateTime = YYYYMMDDHHmmss)
  POST /calendars/events       일정 생성
"""

import json
import os
import re
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "app")


# ---------------------------------------------------------------------------
# 설정 로드 (.env 직접 파싱)
# ---------------------------------------------------------------------------
def load_env():
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if not m:
                continue
            v = m.group(2).strip()
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            os.environ.setdefault(m.group(1), v)


load_env()

PORT = int(os.environ.get("PORT", "5173"))
FLOW_BASE = os.environ.get("FLOW_BASE_URL", "https://api.flow.team/user").rstrip("/")
API_KEY = os.environ.get("FLOW_API_KEY", "")
TIMEZONE = os.environ.get("FLOW_TIMEZONE", "Asia/Seoul")
GMT = os.environ.get("FLOW_GMT", "GMT+09:00")


# ---------------------------------------------------------------------------
# 플로우 인증 방식 자동 탐지
# 문서에 헤더가 명시돼 있지 않아, 표준 후보들을 순서대로 시도하고
# 401/403 이 아닌 첫 방식을 채택해 캐시한다.
# ---------------------------------------------------------------------------
AUTH_CANDIDATES = [
    ("Authorization", lambda k: "Bearer " + k),
    ("Authorization", lambda k: k),
    ("api-key", lambda k: k),
    ("apiKey", lambda k: k),
    ("x-api-key", lambda k: k),
    ("API-KEY", lambda k: k),
]
_auth_scheme = None  # (header, value_fn)

if os.environ.get("FLOW_AUTH_HEADER"):
    _prefix = os.environ.get("FLOW_AUTH_PREFIX", "")
    _auth_scheme = (os.environ["FLOW_AUTH_HEADER"], lambda k, p=_prefix: p + k)


def _raw_flow(method, path_and_query, scheme, body=None):
    """지정한 인증 방식으로 1회 요청. (status, parsed_json, text) 반환."""
    url = FLOW_BASE + path_and_query
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json"}
    headers[scheme[0]] = scheme[1](API_KEY)
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode("utf-8", "replace")
            status = resp.getcode()
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        status = e.code
    except urllib.error.URLError as e:
        raise RuntimeError("플로우 연결 오류: %s" % e.reason)
    try:
        parsed = json.loads(text) if text else None
    except ValueError:
        parsed = None
    return status, parsed, text


def flow(method, path_and_query, body=None):
    """인증 방식을 확정한 뒤 호출. 미확정이면 후보를 순차 탐지."""
    global _auth_scheme
    if not API_KEY:
        raise RuntimeError("FLOW_API_KEY 가 설정되지 않았습니다. .env 를 확인하세요.")
    if _auth_scheme:
        return _raw_flow(method, path_and_query, _auth_scheme, body)
    last = None
    for cand in AUTH_CANDIDATES:
        res = _raw_flow(method, path_and_query, cand, body)
        last = res
        if res[0] not in (401, 403):
            _auth_scheme = cand
            print("[flow] 인증 방식 확정: %s" % cand[0])
            return res
    return last


# ---------------------------------------------------------------------------
# 도메인 로직
# ---------------------------------------------------------------------------
def parse_room(event_name):
    """'[서울] 현대차 모바일 리뷰' -> ('서울', '현대차 모바일 리뷰')"""
    m = re.match(r"^\s*\[([^\]]+)\]\s*(.*)$", event_name or "")
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return None, (event_name or "").strip()


def ts_to_minutes(ts):
    """YYYYMMDDHHmmss -> 자정 기준 분."""
    return int(ts[8:10]) * 60 + int(ts[10:12])


def normalize_event(ev):
    room, title = parse_room(ev.get("eventName"))
    return {
        "eventSrno": ev.get("eventSrno"),
        "calendarSrno": ev.get("calendarSrno"),
        "calendarName": ev.get("calendarName") or ev.get("customCalendarName") or "",
        "eventName": ev.get("eventName"),
        "room": room,
        "title": title,
        "start": ev.get("eventStartDateTime"),
        "finish": ev.get("eventFinishDateTime"),
        "allDay": ev.get("allDayYn") == "Y",
    }


def query_events(start_ts, end_ts):
    """기간 내 일정 전부 조회 (페이지네이션)."""
    out = []
    cursor = None
    for _ in range(20):
        q = "/calendars/events?startDateTime=%s&endDateTime=%s&pageSize=200" % (start_ts, end_ts)
        if cursor:
            q += "&cursor=%s" % cursor
        status, parsed, text = flow("GET", q)
        if status >= 400:
            raise FlowError(status, "플로우 일정 조회 실패 (HTTP %d): %s" % (status, text))
        events = (parsed or {}).get("events", []) or []
        out.extend(events)
        if not parsed or not parsed.get("hasNext"):
            break
        nxt = parsed.get("lastCursor")
        if nxt is None or str(nxt) == "-1":
            break
        cursor = str(nxt)
    return out


def overlaps(a_start, a_end, b_start, b_end):
    """두 구간이 겹치는가 (경계 접촉은 겹침 아님)."""
    return a_start < b_end and b_start < a_end


class FlowError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def fmt_date(d):
    return "%04d%02d%02d" % (d.year, d.month, d.day)


# ---------------------------------------------------------------------------
# API 핸들러 (dict/status 반환)
# ---------------------------------------------------------------------------
def api_calendars():
    status, parsed, text = flow("GET", "/calendars")
    if status >= 400:
        return status, {"error": "calendars 조회 실패", "detail": text}
    j = parsed or {}

    def pick(arr):
        return [
            {
                "calendarSrno": c.get("calendarSrno"),
                "name": c.get("customCalendarName") or c.get("calendarName"),
                "color": c.get("calendarColor"),
            }
            for c in arr
        ]

    editable = pick(j.get("editableCalendars", []) or [])
    view_only = pick((j.get("viewOnlyCalendars", []) or []) + (j.get("projectCalendars", []) or []))
    return 200, {"editable": editable, "viewOnly": view_only}


def api_rooms(params):
    cal = (params.get("calendarSrno") or [None])[0]
    today = datetime.now()
    start_ts = fmt_date(today - timedelta(days=30)) + "000000"
    end_ts = fmt_date(today + timedelta(days=30)) + "235959"
    events = query_events(start_ts, end_ts)
    counts = {}
    for ev in events:
        if cal and str(ev.get("calendarSrno")) != str(cal):
            continue
        room, _ = parse_room(ev.get("eventName"))
        if room:
            counts[room] = counts.get(room, 0) + 1
    rooms = [r for r, _ in sorted(counts.items(), key=lambda kv: -kv[1])]
    return 200, {"rooms": rooms}


def api_events(params):
    date = (params.get("date") or [None])[0]
    cal = (params.get("calendarSrno") or [None])[0]
    if not date:
        return 400, {"error": "date 파라미터 필요 (YYYY-MM-DD)"}
    ymd = date.replace("-", "")
    events = query_events(ymd + "000000", ymd + "235959")
    norm = []
    for ev in events:
        if cal and str(ev.get("calendarSrno")) != str(cal):
            continue
        st = ev.get("eventStartDateTime") or ""
        if st[:8] != ymd:
            continue
        norm.append(normalize_event(ev))
    norm.sort(key=lambda e: e["start"] or "")
    return 200, {"date": date, "events": norm}


def api_book(body):
    required = ["calendarSrno", "room", "title", "date", "startTime", "endTime"]
    for k in required:
        if not body.get(k):
            return 400, {"error": "필수값 누락: %s" % k}
    ymd = str(body["date"]).replace("-", "")
    start_ts = ymd + str(body["startTime"]).replace(":", "") + "00"
    end_ts = ymd + str(body["endTime"]).replace(":", "") + "00"
    if end_ts <= start_ts:
        return 400, {"error": "종료 시각이 시작 시각보다 늦어야 합니다."}

    # --- 중복 예약 차단: 생성 직전 같은 캘린더/같은 방의 당일 일정을 재확인 ---
    day_events = query_events(ymd + "000000", ymd + "235959")
    s_min, e_min = ts_to_minutes(start_ts), ts_to_minutes(end_ts)
    conflict = None
    for ev in day_events:
        if str(ev.get("calendarSrno")) != str(body["calendarSrno"]):
            continue
        n = normalize_event(ev)
        if (n["start"] or "")[:8] != ymd:
            continue
        if n["room"] == body["room"] and overlaps(
            s_min, e_min, ts_to_minutes(n["start"]), ts_to_minutes(n["finish"])
        ):
            conflict = n
            break

    if conflict:
        return 409, {
            "error": "conflict",
            "message": "[%s] 회의실이 해당 시간에 이미 예약돼 있습니다." % body["room"],
            "conflict": {
                "title": conflict["title"] or conflict["eventName"],
                "start": conflict["start"][8:12],
                "finish": conflict["finish"][8:12],
            },
        }

    event_name = "[%s] %s" % (body["room"], body["title"])
    attendees = [a for a in (body.get("attendees") or []) if a]
    event_body = ("참석자: " + ", ".join(attendees)) if attendees else ""

    payload = {
        "calendarSrno": str(body["calendarSrno"]),
        "eventName": event_name,
        "eventBody": event_body,
        "allDayYn": "N",
        "gmtTime": GMT,
        "timezone": TIMEZONE,
        "publicYn": "Y",
        "publicNameYn": "Y",
        "eventStartTimestamp": start_ts,
        "eventFinishTimestamp": end_ts,
    }
    status, parsed, text = flow("POST", "/calendars/events", payload)
    if status >= 400:
        return status, {"error": "일정 생성 실패", "detail": text}
    return 200, {"ok": True, "event": parsed, "eventName": event_name, "start": start_ts, "finish": end_ts}


# ---------------------------------------------------------------------------
# HTTP 서버
# ---------------------------------------------------------------------------
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # 기본 접속 로그 억제

    def _send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_api(self, path, params, body=None):
        try:
            if path == "/api/calendars" and self.command == "GET":
                return self._send_json(*api_calendars())
            if path == "/api/rooms" and self.command == "GET":
                return self._send_json(*api_rooms(params))
            if path == "/api/events" and self.command == "GET":
                return self._send_json(*api_events(params))
            if path == "/api/book" and self.command == "POST":
                return self._send_json(*api_book(body or {}))
            return self._send_json(404, {"error": "unknown api"})
        except FlowError as e:
            return self._send_json(e.status if e.status else 502, {"error": e.message})
        except Exception as e:  # noqa
            return self._send_json(500, {"error": str(e)})

    def _serve_static(self, path):
        rel = path
        if rel == "/":
            rel = "/index.html"
        file_path = os.path.normpath(os.path.join(PUBLIC_DIR, rel.lstrip("/")))
        if not file_path.startswith(PUBLIC_DIR):
            self.send_response(403)
            self.end_headers()
            return
        if not os.path.isfile(file_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"not found")
            return
        with open(file_path, "rb") as f:
            data = f.read()
        ext = os.path.splitext(file_path)[1]
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            return self._handle_api(u.path, parse_qs(u.query))
        return self._serve_static(u.path)

    def do_POST(self):
        u = urlparse(self.path)
        body = {}
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except ValueError:
                return self._send_json(400, {"error": "잘못된 JSON 본문"})
        if u.path.startswith("/api/"):
            return self._handle_api(u.path, parse_qs(u.query), body)
        self.send_response(404)
        self.end_headers()


def main():
    print("\n  회의실 예약 페이지  ->  http://localhost:%d\n" % PORT)
    if not API_KEY:
        print("  !  FLOW_API_KEY 가 없습니다. .env.example 을 복사해 .env 를 만들고 키를 넣으세요.\n")
    else:
        try:
            status, _, _ = flow("GET", "/calendars")
            if status >= 400:
                print("  !  플로우 연결 확인 실패 (HTTP %d). API 키/인증 방식을 확인하세요." % status)
            else:
                print("  o  플로우 연결 정상.")
        except Exception as e:  # noqa
            print("  !  플로우 연결 오류: %s" % e)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
