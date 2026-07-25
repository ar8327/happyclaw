import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

export function FeishuOAuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>(
    'processing',
  );
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setStatus('error');
      setErrorMsg(
        error === 'access_denied'
          ? '你取消了授权'
          : `授权失败: ${error}`,
      );
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setErrorMsg('缺少授权参数');
      return;
    }

    // Exchange code for tokens
    const redirectUri = `${window.location.origin}/feishu-oauth-callback`;

    api
      .post('/api/config/im/feishu/oauth-callback', {
        code,
        state,
        redirectUri,
      })
      .then(() => {
        setStatus('success');
        // Redirect to settings after 2 seconds
        setTimeout(() => navigate('/settings?tab=im&oauth=success'), 2000);
      })
      .catch((err: { message?: string; body?: { error?: string } }) => {
        setStatus('error');
        setErrorMsg(
          err?.body?.error || err?.message || '授权回调失败',
        );
      });
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="max-w-md w-full bg-card rounded-lg shadow-md p-8 text-center">
        {status === 'processing' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-foreground">
              正在完成授权...
            </h2>
            <p className="text-sm text-muted-foreground mt-2">请稍候</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="text-4xl mb-4">✅</div>
            <h2 className="text-lg font-semibold text-foreground">
              飞书文档授权成功！
            </h2>
            <p className="text-sm text-muted-foreground mt-2">
              正在跳转回设置页面...
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="text-4xl mb-4">❌</div>
            <h2 className="text-lg font-semibold text-foreground">授权失败</h2>
            <p className="text-sm text-error mt-2">{errorMsg}</p>
            <button
              onClick={() => navigate('/settings?tab=im')}
              className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary transition-colors"
            >
              返回设置页
            </button>
          </>
        )}
      </div>
    </div>
  );
}
