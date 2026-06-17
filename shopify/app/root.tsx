import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from '@remix-run/react';
import { json } from '@remix-run/node';
import type { LoaderFunctionArgs } from '@remix-run/node';
import { AppProvider } from '@shopify/polaris';
import '@shopify/polaris/build/esm/styles.css';

export async function loader({ request }: LoaderFunctionArgs) {
  return json({
    workbenchApiUrl: process.env.WORKBENCH_API_URL || 'http://localhost:3890',
  });
}

export default function App() {
  const { workbenchApiUrl } = useLoaderData<typeof loader>();

  return (
    <html lang="es">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.ENV = ${JSON.stringify({ WORKBENCH_API_URL: workbenchApiUrl })}`,
          }}
        />
      </head>
      <body>
        <AppProvider i18n={{}}>
          <Outlet />
        </AppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
