import React, { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return <main className="mx-auto max-w-3xl p-8 text-slate-900">
    <p className="text-sm font-medium text-blue-600">MYSCube AXR · 독립 검증 화면</p>
    <h1 className="mt-3 text-3xl font-bold">React 원문 Git 전달 검증</h1>
    <p className="mt-4 text-slate-600">운영 데이터와 API가 연결되지 않은 테스트 페이지입니다.</p>
    <button className="mt-6 rounded-xl bg-blue-600 px-5 py-3 text-white" onClick={() => setCount(count + 1)}>
      동작 확인 {count}회
    </button>
  </main>;
}
