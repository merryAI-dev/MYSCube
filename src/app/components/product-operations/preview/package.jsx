import React, { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;
function Page({ page, report }) {
  useLayoutEffect(() => { report('ready'); }, []);
  return <main><h1>{page.title}</h1><p>{page.description}</p><div className="grid">{page.widgets.map((widget) => <section key={widget.id} className={widget.width === 'half' ? 'half' : ''}>
    <h2>{widget.title}</h2><p className="meta">{widget.source} · {widget.period} · {widget.queriedAt}</p>
    {widget.error ? <p className="error">{widget.error}</p> : <>
      <div className="metrics">{widget.metrics.map((metric) => <article key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></article>)}</div>
      {widget.rows.length > 0 && widget.display !== 'cards' && <div className="scroll"><table><thead><tr>{widget.columns.map((title) => <th key={title}>{title}</th>)}</tr></thead><tbody>{widget.rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>)}</tbody></table></div>}
      {widget.display === 'cards' && widget.rows.map((row, index) => <article key={index} style={{ borderTop: '1px solid #e2e8f0', padding: '12px 0' }}>{row.map((value, column) => <p key={column}><strong>{widget.columns[column]}: </strong>{value}</p>)}</article>)}
      {widget.bars?.length > 0 && <div aria-label="관측된 일별 업무 시도"><p>날짜별 시스템 오류 / 관측 업무 시도</p>{widget.bars.map((bar) => <div className="bar" key={bar.label}><span>{bar.label}</span><div style={{ width: `${bar.width}%` }} /><span>{bar.value}</span></div>)}</div>}
    </>}
    {widget.notes.map((note, index) => <p className="note" key={index}>{note}</p>)}
  </section>)}</div></main>;
}
class Boundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.report('error'); }
  render() { return this.state.failed ? null : this.props.children; }
}
export function render(page, report) {
  createRoot(document.getElementById('root')).render(<Boundary report={report}><Page page={page} report={report} /></Boundary>);
}
