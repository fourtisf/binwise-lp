'use client';

import { useState } from 'react';
import { Chips } from '@/components/Chips';
import { FeedItem } from '@/components/FeedItem';
import { useAppData } from '@/lib/store';

export default function ActivityPage() {
  const { decisions } = useAppData();
  const [filter, setFilter] = useState('all');
  const list = filter === 'all' ? decisions : decisions.filter((d) => d.type === filter);
  return (
    <div className="page on" id="p-activity">
      <div className="toolbar">
        <Chips
          id="actChips"
          items={[
            ['all', 'All'],
            ['deploy', 'Deploys'],
            ['rebalance', 'Rebalances'],
            ['exit', 'Exits'],
            ['compound', 'Compounds'],
            ['scan', 'Scans'],
          ]}
          current={filter}
          onPick={setFilter}
        />
      </div>
      <div className="panel card">
        <div className="feed" id="feedAll" style={{ maxHeight: 'none' }}>
          {list.length ? (
            list.map((d) => <FeedItem d={d} key={d.id} />)
          ) : (
            <p className="muted" style={{ padding: '20px 0' }}>
              Nothing of this type yet. It shows up here the moment the agent does it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
