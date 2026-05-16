import { parseReply } from '../../src/modules/jobs/processors/av/clamd-client';

describe('clamd reply parser', () => {
  it('treats `stream: OK` as clean', () => {
    expect(parseReply('stream: OK')).toEqual({ status: 'OK' });
  });

  it('extracts signature on FOUND', () => {
    expect(parseReply('stream: Eicar-Test-Signature FOUND')).toEqual({
      status: 'FOUND',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('extracts message on ERROR', () => {
    expect(parseReply('stream: ERROR Database not loaded')).toEqual({
      status: 'ERROR',
      message: 'Database not loaded',
    });
  });

  it('falls back to ERROR for malformed replies', () => {
    const result = parseReply('what');
    expect(result.status).toBe('ERROR');
  });
});
