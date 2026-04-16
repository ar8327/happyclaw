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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-md p-8 text-center">
        {status === 'processing' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-gray-900">
              正在完成授权...
            </h2>
            <p className="text-sm text-gray-500 mt-2">请稍候</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="text-4xl mb-4">✅</div>
            <h2 className="text-lg font-semibold text-gray-900">
              飞书文档授权成功！
            </h2>
            <p className="text-sm text-gray-500 mt-2">
              正在跳转回设置页面...
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="text-4xl mb-4">❌</div>
            <h2 className="text-lg font-semibold text-gray-900">授权失败</h2>
            <p className="text-sm text-red-600 mt-2">{errorMsg}</p>
            <button
              onClick={() => navigate('/settings?tab=im')}
              className="mt-4 px-4 py-2 bg-teal-600 text-white rounded-md hover:bg-teal-700 transition-colors"
            >
              返回设置页
            </button>
          </>
        )}
      </div>
    </div>
  );
}
