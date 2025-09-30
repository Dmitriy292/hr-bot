import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as XLSX from 'xlsx';
import { parse } from 'date-fns';

function two(n: number){ return String(n).padStart(2,'0'); }

// Excel serial to Date
function excelSerialToDate(n: number): Date {
  const ms = (n - 25569) * 86400 * 1000;
  return new Date(ms);
}

function splitList(raw: any): string[] {
  if (raw === null || raw === undefined) return [];
  if (raw instanceof Date) return [raw.toISOString()];
  if (typeof raw === 'number') return [String(raw)];
  let s = String(raw);
  s = s.replace(/[,\|]/g, ';');
  s = s.replace(/[\r\n\t]+/g, ';');
  s = s.replace(/\s*;\s*/g, ';');
  s = s.replace(/;{2,}/g, ';');
  s = s.replace(/^\s*;\s*|\s*;\s*$/g, '');
  const parts = s.split(';').map(p => p.trim()).filter(Boolean);
  return Array.from(new Set(parts));
}

function normalTime(raw: any): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    return `${two(raw.getHours())}:${two(raw.getMinutes())}`;
  }
  if (typeof raw === 'number') {
    const d = excelSerialToDate(raw);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  const str = String(raw).trim();
  if (!str) return null;
  const digits = str.replace(/[^\d]/g, '');
  if (digits.length === 3) {
    const h = digits.slice(0,1), m = digits.slice(1);
    return `${two(parseInt(h,10))}:${two(parseInt(m,10))}`;
  }
  if (digits.length === 4) {
    const h = digits.slice(0,2), m = digits.slice(2);
    return `${two(parseInt(h,10))}:${two(parseInt(m,10))}`;
  }
  const m = str.match(/^(\d{1,2})\D(\d{2})$/);
  if (m) return `${two(parseInt(m[1],10))}:${two(parseInt(m[2],10))}`;
  return null;
}

function normalDate(raw: any): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    return `${two(raw.getDate())}.${two(raw.getMonth()+1)}.${raw.getFullYear()}`;
  }
  if (typeof raw === 'number') {
    const d = excelSerialToDate(raw);
    return `${two(d.getDate())}.${two(d.getMonth()+1)}.${d.getFullYear()}`;
  }
  let s = String(raw).trim();
  if (!s) return null;
  s = s.split('T')[0].trim();
  s = s.replace(/[\/\-]/g,'.').replace(/\s+/g,'.');
  s = s.replace(/\.{2,}/g,'.').replace(/^\./,'').replace(/\.$/,'');
  const m = s.match(/^(\d{1,4})\.(\d{1,2})\.(\d{1,4})$/);
  if (!m) return null;
  const a=m[1], b=m[2], c=m[3];
  let dd:string, MM:string, yyyy:string;
  if (a.length===4){ yyyy=a; MM=two(parseInt(b,10)); dd=two(parseInt(c,10)); }
  else if (c.length===4){ dd=two(parseInt(a,10)); MM=two(parseInt(b,10)); yyyy=c; }
  else return null;
  const idd=parseInt(dd,10), iMM=parseInt(MM,10), iyyyy=parseInt(yyyy,10);
  if (iMM<1||iMM>12||idd<1||idd>31||iyyyy<1900||iyyyy>3000) return null;
  return `${two(idd)}.${two(iMM)}.${yyyy}`;
}

function parseDatesCell(raw:any): string[] {
  if (raw instanceof Date || typeof raw === 'number') {
    const one = normalDate(raw);
    return one ? [one] : [];
  }
  const parts = splitList(raw);
  const out = parts.map(normalDate).filter((v): v is string => !!v);
  return Array.from(new Set(out));
}
function parseTimesCell(raw:any): string[] {
  if (raw instanceof Date || typeof raw === 'number') {
    const one = normalTime(raw);
    return one ? [one] : [];
  }
  const parts = splitList(raw);
  const out = parts.map(normalTime).filter((v): v is string => !!v);
  return Array.from(new Set(out));
}
function parseStringListCell(raw:any): string[] {
  if (raw === null || raw === undefined) return [];
  if (raw instanceof Date || typeof raw === 'number') return [String(raw)];
  const parts = splitList(raw);
  const list = parts.length ? parts : [String(raw).trim()];
  return list.filter(Boolean);
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(private prisma: PrismaService) {}

  async ingestExcel(buffer: ArrayBuffer): Promise<{ events: number; notifications: number }> {
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true, cellNF: true, cellText: false });
    const sh = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sh, { header: 1, raw: true });

    let events = 0;
    let notifs = 0;

    let lastDates: string[] = [];
    let lastTimes: string[] = [];

    for (let i=1; i<rows.length; i++){
      const row = rows[i] || [];
      const nameRaw = row[0];
      const datesRaw = row[1];
      const timesRaw = row[2];
      const msgRaw   = row[3];

      const names = parseStringListCell(nameRaw);
      const msgs  = parseStringListCell(msgRaw);
      if (names.length===0 || msgs.length===0) continue;

      let dates = parseDatesCell(datesRaw);
      let times = parseTimesCell(timesRaw);

      if (dates.length===0) dates = lastDates.slice();
      if (times.length===0) times = lastTimes.slice();
      if (dates.length===0 || times.length===0) continue;

      if (parseDatesCell(datesRaw).length>0) lastDates = dates.slice();
      if (parseTimesCell(timesRaw).length>0) lastTimes = times.slice();

      for (let idx=0; idx<names.length; idx++){
        const name = names[idx];
        const message = msgs[idx] ?? msgs[0];

        await this.prisma.$transaction(async tx => {
          const ev = await tx.event.create({ data: { name, message } });
          events++;

          const data: {eventId: string; at: Date}[] = [];
          for (const d of dates){
            for (const t of times){
              try {
                const at = parse(`${d} ${t}`, 'dd.MM.yyyy HH:mm', new Date());
                if (!isNaN(at.getTime())) data.push({ eventId: ev.id, at });
              } catch {}
            }
          }

          if (data.length){
            const chunk = 500;
            for (let start=0; start<data.length; start+=chunk){
              const slice = data.slice(start, start+chunk);
              const res = await tx.notification.createMany({ data: slice });
              notifs += res.count;
            }
          }
        });
      }
    }

    return { events, notifications: notifs };
  }

  async dueNotifications(now: Date, graceMs = 0) {
    const threshold = new Date(now.getTime() + graceMs);
    return this.prisma.notification.findMany({
      where: { delivered: false, at: { lte: threshold } },
      include: { event: true },
      orderBy: { at: 'asc' },
      take: 500,
    });
  }

  async markDelivered(id: string) {
    await this.prisma.notification.update({ where: { id }, data: { delivered: true } });
  }

  async cleanupEventsWithoutPending() {
    const events = await this.prisma.event.findMany({
      include: { notifications: { where: { delivered: false }, select: { id: true } } },
    });
    for (const e of events) {
      if (e.notifications.length === 0) {
        await this.prisma.event.delete({ where: { id: e.id } });
      }
    }
  }
}
