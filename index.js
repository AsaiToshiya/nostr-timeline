import * as fs from "fs";

import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { marked } from "marked";
import { SimplePool, nip19 } from "nostr-tools";
import "websocket-polyfill";

// アカウントの公開鍵
const PK = nip19.decode(process.env.NPUB).data;

// リレー サーバー
const RELAYS = JSON.parse(process.env.RELAYS.replace(/'/g, '"'));

marked.setOptions({
  breaks: true,
});

const byCreateAt = (a, b) => a.created_at - b.created_at;

const byCreateAtDesc = (a, b) => b.created_at - a.created_at;

const escape = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const fetchPosts = async (relay, authors, since, until, olderPost) => {
  const posts = (
    await pool.list(
      [relay],
      [
        {
          authors,
          kinds: [1],
          since,
          until,
          limit: 200,
        },
      ]
    )
  ).sort(byCreateAtDesc);
  const oldestPost = posts[posts.length - 1];
  return [
    ...(oldestPost && oldestPost.id !== olderPost?.id
      ? await fetchPosts(
          relay,
          authors,
          since,
          oldestPost.created_at,
          oldestPost
        )
      : []),
    ...posts,
  ];
};

// UNIX 時間を返す
const getTodayWithoutTime = () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(today.getTime() / 1000);
};

// UNIX 時間を返す
const getTomorrowWithoutTime = (date) => {
  const tomorrow = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );
  tomorrow.setDate(tomorrow.getDate() + 1);
  return Math.floor(tomorrow.getTime() / 1000);
};

const args = process.argv;
const [option1, value1, option2, value2] = args;
const dateIndex = args.indexOf("-d") || args.indexOf("--date");
const todayUnixTime =
  dateIndex > -1
    ? getTomorrowWithoutTime(new Date(args[dateIndex + 1]))
    : getTomorrowWithoutTime(new Date());
const excludeIndex = args.indexOf("-e") || args.indexOf("--exclude");
const excludeUsers = excludeIndex > -1 ? args[excludeIndex + 1].split(",") : [];
const timeoutIndex = args.indexOf("-t") || args.indexOf("--timeout");
const hasTimeout = timeoutIndex > -1;
const timeout = hasTimeout ? args[timeoutIndex + 1] : 3 * 60 * 1000;
const sortIndex = args.indexOf("-s") || args.indexOf("--sort");
const sort = args[sortIndex + 1] == "asc" ? byCreateAt : byCreateAtDesc;
const yesterdayUnixTime = todayUnixTime - 86400;
const yesterday = new Date(yesterdayUnixTime * 1000);
const exclusionNpubs = excludeUsers
  .filter((value) => value.length == 63 && value.startsWith("npub"))
  .map((npub) => nip19.decode(npub).data);
const exclusionNames = excludeUsers.filter(
  (value) => value.length != 63 || !value.startsWith("npub")
);

const pool = new SimplePool({
  eoseSubTimeout: timeout,
  getTimeout: timeout,
});

// フォロー
const following = (
  await pool.list(RELAYS, [
    {
      authors: [PK],
      kinds: [3],
    },
  ])
)
  .filter((following) => following.tags && following.tags.length > 0)
  .sort(byCreateAtDesc)
  .shift();

// フォローの pubkey
const authors = following.tags
  ?.map((tag) => tag[1])
  .filter((pk) => !exclusionNpubs.includes(pk));

// チャンク化する
const chunkSize = 250;
const chunkedAuthors = authors.reduce((acc, obj, index) => {
  const chunkIndex = Math.floor(index / chunkSize);
  const chunk = acc[chunkIndex] ?? [];
  return [
    ...acc.slice(0, chunkIndex),
    [...chunk, obj],
    ...acc.slice(chunkIndex + 1),
  ];
}, []);

// 投稿
const posts = [
  ...new Map(
    (
      await Promise.all(
        RELAYS.map(async (relay) =>
          (
            await Promise.all(
              chunkedAuthors.map(
                async (authors) =>
                  await fetchPosts(
                    relay,
                    authors,
                    yesterdayUnixTime - 1,
                    todayUnixTime
                  )
              )
            )
          ).flat()
        )
      )
    )
      .flat()
      .map((obj) => [obj.id, obj])
  ).values(),
].sort(sort);

// 投稿者の pubkey
const postAuthors = posts.map((post) => post.pubkey);

// プロフィール
const profiles = (
  await pool.list(RELAYS, [
    {
      authors: postAuthors,
      kinds: [0],
    },
  ])
)
  .sort(byCreateAt)
  .reduce(
    (acc, obj) => ({ ...acc, [obj.pubkey]: JSON.parse(obj.content) }),
    {}
  );

const filteredPosts = posts.filter((post) => {
  const author = profiles[post.pubkey] ?? {};
  const name = author.name ?? author.username;
  return !exclusionNames.includes(name);
});

// HTML を作成する
const date = yesterday.toLocaleDateString();
const html =
  `<!DOCTYPE html>
  <html lang="ja">
    <head>
      <meta charset="utf8" />
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="github-markdown.css">
      <style>
        .markdown-body {
          box-sizing: border-box;
          min-width: 200px;
          max-width: 980px;
          margin: 0 auto;
          padding: 45px;
        }
      
        @media (max-width: 767px) {
          .markdown-body {
            padding: 15px;
          }
        }

        img {
          max-width: 600px;
        }

        @media screen and (max-width: 600px) {
          img {
            max-width: 100%;
          }
        }
      </style>
      <title>${date} のタイムライン</title>
    </head>
    <body class="markdown-body">
      <h1>${date} のタイムライン</h1>
` +
  filteredPosts
    .map((post) => {
      const author = profiles[post.pubkey] ?? {};
      const displayName = author.display_name ?? author.displayName ?? "";
      const name = author.name ?? author.username;
      const content = marked.parse(
        escape(post.content)
          .replace(
            /(https?:\/\/\S+\.(jpg|jpeg|png|webp|avif|gif))/g,
            '<a href="$1"><img src="$1" loading="lazy"></a>'
          )
          .replace(
            /NIP-(\d{2})/g,
            '<a href="https://github.com/nostr-protocol/nips/blob/master/$1.md">$&</a>'
          )
          .replace(/^#+ /g, "\\$&")
      );
      const date = new Date(post.created_at * 1000);
      const time = date.toLocaleTimeString();
      return `      <p>${displayName}@${name}</p>
      ${content}
      <p>${time}</p>`;
    })
    .join("\n") +
  `
    </body>
  </html>`;

// ファイルに出力する
fs.writeFileSync("index.html", html);

// await pool.close(RELAYS); // TypeError: Cannot read properties of undefined (reading 'sendCloseFrame')
process.exit(); // HACK: 強制終了する
