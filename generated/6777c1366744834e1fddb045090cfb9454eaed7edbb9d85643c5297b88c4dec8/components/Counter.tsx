import React, { useState } from "react";
import { formatCount } from "../lib/format";
export default function Counter() {
  const [count, setCount] = useState(0);
  return <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6"><p aria-live="polite">{formatCount(count)}</p><button className="mt-4 rounded-xl bg-blue-600 px-5 py-3 text-white" onClick={() => setCount(count + 1)}>합성 카운터 증가</button></section>;
}
