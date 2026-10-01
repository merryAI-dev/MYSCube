import React, { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return <main className="min-h-screen bg-slate-50 p-8 text-slate-900">
    <p className="text-sm font-semibold text-blue-600">MYSCube · 나의 업무 화면</p>
    <h1 className="mt-3 text-3xl font-bold">필요한 업무를 한곳에서</h1>
    <p className="mt-4 text-slate-500">버튼을 눌러 React 실행을 확인하세요. 업무 수치는 연결 API로 조회합니다.</p>
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
      <button className="rounded-xl bg-blue-600 px-5 py-3 font-semibold text-white" onClick={() => setCount(count + 1)}>실행 확인 {count}회</button>
    </section>
  </main>;
}