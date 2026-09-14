import { expect, it } from 'vitest';
import * as feedback from './settlement-feedback.mjs';

it('fits the unique L2 logistic optimum and matches numerical differentiation', () => {
  expect(typeof feedback.fitFeedback).toBe('function');
  const data = [{ id: 'a', value: 1 }, { id: 'b', value: 1 }, { id: 'c', value: 0 }];
  const model = feedback.fitFeedback(data);
  expect(model.weight).toBeGreaterThan(0);
  expect(Math.abs(model.gradient)).toBeLessThan(1e-12);
  const h = 1e-5;
  const x = 0.3;
  const numeric = (feedback.feedbackLoss(x + h, 2 / 3) - feedback.feedbackLoss(x - h, 2 / 3)) / (2 * h);
  expect(numeric).toBeCloseTo(1 / (1 + Math.exp(-x)) - 2 / 3 + x, 8);
  expect(feedback.fitFeedback([{ id: 'a', value: 0 }]).probability).toBeLessThan(0.5);
  expect(feedback.fitFeedback([]).probability).toBe(0.5);
});

it('replays independent of arrival order, ignores duplicate delivery, rejects contradictions', () => {
  const data = [{ id: 'a', value: 1 }, { id: 'b', value: 0 }];
  expect(feedback.fitFeedback([...data].reverse())).toEqual(feedback.fitFeedback(data));
  expect(feedback.fitFeedback([...data, data[0]])).toEqual(feedback.fitFeedback(data));
  expect(() => feedback.fitFeedback([...data, { id: 'a', value: 0 }])).toThrow();
  expect(() => feedback.fitFeedback([{ id: 'a', value: NaN }])).toThrow();
});
