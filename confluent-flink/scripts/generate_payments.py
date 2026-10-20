#!/usr/bin/env python3
"""Deterministic fraud scenarios. No Python dependencies; produces through Kafka CLI."""
import argparse
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path


def make_event(tx, user, merchant, amount, device, at):
    return dict(transaction_id=tx, user_id=user, merchant_id=merchant,
                amount=round(amount, 2), device_id=device,
                payment_channel='CARD_PRESENT',
                event_time=at.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3])


def generate(base):
    events=[]
    # Ordinary amounts alone are not a fraud signal.
    for i, amount in enumerate((12.5, 37.0, 95.0)):
        events.append(make_event(f'normal-{i}', 'customer-normal',
                                 f'shop-{i}', amount, 'phone-normal',
                                 base + timedelta(seconds=i*20)))
    # Rapid repeat purchases: 6 in < 1 minute, same merchant.
    for i in range(6):
        events.append(make_event(f'velocity-{i}', 'customer-velocity',
                                 'shop-repeat', 10+i, 'phone-velocity',
                                 base + timedelta(seconds=10+i*4)))
    # Merchant hopping: 7 ordinary transactions, 7 merchants.
    for i in range(7):
        events.append(make_event(f'hopping-{i}', 'customer-hopping',
                                 f'shop-{i}', 20+i*7, 'phone-hopping',
                                 base + timedelta(seconds=10+i*4)))
    # Advances single-partition event-time watermark to close windows.
    # This is a test fixture, not a real payment.
    events.append(make_event('watermark-marker', '__watermark__',
                             '__none__', 0, '__none__',
                             base + timedelta(minutes=6)))
    return events


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args=parser.parse_args()
    base=datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)-timedelta(minutes=3)
    events=generate(base)
    payload='\n'.join(json.dumps(e, separators=(',', ':')) for e in events)+'\n'
    if args.dry_run:
        print(payload, end='')
        return
    subprocess.run(['podman','compose','exec','-T','kafka',
                    'kafka-console-producer','--bootstrap-server','kafka:29092',
                    '--topic','payments.raw.demo'],
                   input=payload, text=True, check=True)
    print(f'Published {len(events)-1} synthetic payments and one watermark marker.')

if __name__ == '__main__':
    main()
