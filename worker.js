// Cloudflare Worker for translation tasks
import { Pool } from "@prisma/pg-worker";

export default {
  async scheduled(event, env, ctx) {
    const cronBatchSize = Number(env.CRON_BATCH_SIZE || 1);
    ctx.waitUntil(processPendingTasks(env, cronBatchSize));
  },
  async fetch(request, env, ctx) {
    // 只处理 POST 请求
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      // 解析请求体
      const body = await request.json();
      const { task: taskUuid, password } = body;

      // 验证密码
      if (password !== env.PASSWORD) {
        return new Response(JSON.stringify({ error: "Invalid password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const response = new Response(JSON.stringify({ ok: "true" }), {
        headers: { "Content-Type": "application/json" },
      });
      ctx.waitUntil(
        processTranslationTask(taskUuid, env, {
          timeoutMs: 0,
          source: "fetch",
        })
      );
      return response;
    } catch (error) {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

async function processPendingTasks(env, limit = 1) {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
  try {
    const pending = await pool.query(
      'SELECT id FROM "Task" WHERE status = $1 ORDER BY "createdAt" DESC LIMIT $2',
      ["PENDING", limit]
    );
    if (!pending.rows.length) {
      console.log(`[${new Date().toISOString()}] 无待处理翻译任务`);
      return;
    }

    console.log(
      `[${new Date().toISOString()}] 定时任务开始处理 ${pending.rows.length} 个待翻译任务`
    );
    for (const row of pending.rows) {
      try {
        await processTranslationTask(row.id, env, {
          timeoutMs: 0,
          source: "cron",
        });
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] 定时任务处理失败: ${row.id}`,
          error
        );
      }
    }
  } finally {
    await pool.end();
  }
}

async function processTranslationTask(taskUuid, env, options = {}) {
  const startTime = Date.now();
  const source = options.source || "unknown";
  const timeoutMs = Number(options.timeoutMs ?? 0);
  console.log(
    `[${new Date().toISOString()}] 开始处理翻译任务: ${taskUuid} source=${source} timeoutMs=${timeoutMs}`
  );
  // console.log(`[${new Date().toISOString()}] 开始处理翻译任务: ${taskUuid}`);
  // fetch(`${env.FORUM_URL}/api/task/report`, {
  //   method: "POST",
  //   body: JSON.stringify({
  //     password: env.PASSWORD,
  //     task: taskUuid,
  //     status: "PROCESSING",
  //   }),
  // });

  // 使用 Hyperdrive 连接
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
  const abortController = timeoutMs > 0 ? new AbortController() : null;
  const timeoutId =
    abortController &&
    setTimeout(() => {
      abortController.abort(`Task timeout: exceeded ${timeoutMs}ms`);
    }, timeoutMs);
  const throwIfAborted = () => {
    if (abortController?.signal?.aborted) {
      const reason = abortController.signal.reason;
      throw new Error(
        typeof reason === "string" ? reason : "Task aborted by timeout"
      );
    }
  };

  // 创建实际任务Promise
  const taskPromise = async () => {
    try {
      console.log(`[${new Date().toISOString()}] 正在连接数据库...`);
      throwIfAborted();

      // 从数据库获取任务
      const taskResult = await pool.query(
        'SELECT * FROM "Task" WHERE id = $1',
        [taskUuid]
      );
      throwIfAborted();

      if (taskResult.rows.length === 0) {
        throw new Error("Task not found");
      }

      const task = taskResult.rows[0];
      console.log(
        `[${new Date().toISOString()}] 成功获取任务数据: postId=${
          task.postId
        }, replyId=${task.replyId}`
      );

      let postData = null;
      let replyData = null;

      // 获取关联的帖子或回复数据
      if (task.postId) {
        console.log(`[${new Date().toISOString()}] 正在获取帖子数据...`);
        const postResult = await pool.query(
          'SELECT * FROM "Post" WHERE id = $1',
          [task.postId]
        );
        throwIfAborted();
        if (postResult.rows.length > 0) {
          postData = postResult.rows[0];
          console.log(
            `[${new Date().toISOString()}] 成功获取帖子数据: title="${postData.title?.substring(
              0,
              50
            )}..."`
          );
        }
      }

      if (task.replyId) {
        console.log(`[${new Date().toISOString()}] 正在获取回复数据...`);
        const replyResult = await pool.query(
          'SELECT * FROM "Reply" WHERE id = $1',
          [task.replyId]
        );
        throwIfAborted();
        if (replyResult.rows.length > 0) {
          replyData = replyResult.rows[0];
          console.log(
            `[${new Date().toISOString()}] 成功获取回复数据: content="${replyData.content?.substring(
              0,
              50
            )}..."`
          );
        }
      }

      let aiPrompt = "";
      let inputJson = {};
      let isPost = false;

      // 判断是帖子还是回复
      if (postData) {
        isPost = true;
        console.log(`[${new Date().toISOString()}] 准备处理帖子翻译`);
        inputJson = {
          title: postData.title,
          content: postData.origin,
        };

        aiPrompt = `你是论坛翻译器。仅输出一个合法 JSON 对象，不要 Markdown。
输入:
${JSON.stringify(inputJson)}

输出 schema:
{
  "title": "",
  "content": "",
  "langage": "",
  "translate": {
    "en-US": { "title": "", "content": "" },
    "zh-CN": { "title": "", "content": "" },
    "zh-TW": { "title": "", "content": "" },
    "es-ES": { "title": "", "content": "" },
    "fr-FR": { "title": "", "content": "" },
    "ru-RU": { "title": "", "content": "" },
    "ja-JP": { "title": "", "content": "" },
    "de-DE": { "title": "", "content": "" },
    "pt-BR": { "title": "", "content": "" },
    "ko-KR": { "title": "", "content": "" }
  },
  "unsafeTags": [
    "暴力",
    "涉政",
    "色情",
    "种族主义",
    "误导性内容",
    "侵犯隐私",
    "自残",
    "毒品",
    "无意义内容"
  ]
}
规则:
1) 自动识别原文语言，写入 langage，且 langage 只能是 en-US/zh-CN/zh-TW/es-ES/fr-FR/ru-RU/ja-JP/de-DE/pt-BR/ko-KR 之一。
2) 与原文同语言的 translate 字段留空字符串。
3) unsafeTags 只能从给定列表中选择；无风险则 []。`;
      } else if (replyData) {
        console.log(`[${new Date().toISOString()}] 准备处理回复翻译`);
        inputJson = {
          content: replyData.content,
        };

        aiPrompt = `你是论坛翻译器。仅输出一个合法 JSON 对象，不要 Markdown。
输入:
${JSON.stringify(inputJson)}

输出 schema:
{
  "content": "",
  "langage": "",
  "translate": {
    "en-US": "",
    "zh-CN": "",
    "zh-TW": "",
    "es-ES": "",
    "fr-FR": "",
    "ru-RU": "",
    "ja-JP": "",
    "de-DE": "",
    "pt-BR": "",
    "ko-KR": ""
  },
  "unsafeTags": [
    "暴力",
    "涉政",
    "色情",
    "种族主义",
    "误导性内容",
    "侵犯隐私",
    "自残",
    "毒品",
    "无意义内容"
  ]
}
规则:
1) 自动识别原文语言，写入 langage，且 langage 只能是 en-US/zh-CN/zh-TW/es-ES/fr-FR/ru-RU/ja-JP/de-DE/pt-BR/ko-KR 之一。
2) 与原文同语言的 translate 字段留空字符串。
3) unsafeTags 只能从给定列表中选择；无风险则 []。`;
      } else {
        throw new Error("No post or reply found in task");
      }

      // 调用 （通过 AI Gateway）
      console.log(`[${new Date().toISOString()}] 正在调用 API...`);
      if (!env.AI_TOKEN) {
        throw new Error("Missing AI_TOKEN");
      }
      if (!env.AI_GATEWAY_TOKEN) {
        throw new Error("Missing AI_GATEWAY_TOKEN");
      }

      const aiResponse = await fetch(env.AI_URL, {
        method: "POST",
        ...(abortController ? { signal: abortController.signal } : {}),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.AI_TOKEN}`,
          "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          model: "custom-dooo/gpt-5.3",
          messages: [
            {
              role: "user",
              content: aiPrompt,
            },
          ],
          temperature: 0.2,
          max_tokens: 3200,
          response_format: { type: "json_object" },
        }),
      });

      if (!aiResponse.ok) {
        throw new Error(`AI API error: ${aiResponse.status}`);
      }

      const aiData = await aiResponse.json();
      throwIfAborted();
      let aiContent = aiData?.choices?.[0]?.message?.content || "";
      if (Array.isArray(aiContent)) {
        aiContent = aiContent.map((item) => item?.text || "").join("");
      }
      if (!aiContent) {
        throw new Error("Empty AI response content");
      }
      console.log(
        `[${new Date().toISOString()}] AI API 调用成功，响应长度: ${
          aiContent.length
        } 字符`
      );

      // 尝试解析 AI 返回的 JSON
      let translationResult;
      let jsonString;
      try {
        console.log(`[${new Date().toISOString()}] 正在解析 AI 返回的 JSON...`);
        jsonString = extractJsonCandidate(aiContent);
        translationResult = JSON.parse(jsonString.trim());
        console.log(
          `[${new Date().toISOString()}] JSON 解析成功，检测到语言: ${
            translationResult.langage
          }`
        );
      } catch (parseError) {
        console.error(
          `[${new Date().toISOString()}] JSON 解析失败:`,
          parseError.message
        );
        console.error(`[${new Date().toISOString()}] AI 原始响应:`, aiContent);
        console.error(`[${new Date().toISOString()}] 提取的 JSON 字符串:`, jsonString);
        // 清理不可见控制字符后再次解析
        try {
          console.log(`[${new Date().toISOString()}] 尝试清理控制字符后再次解析 JSON...`);
          const cleaned = jsonString
            .replace(/^\uFEFF/, "")
            .replace(/[\u0000-\u0019]/g, " ");
          translationResult = JSON.parse(cleaned.trim());
          console.log(`[${new Date().toISOString()}] 转义后 JSON 解析成功，检测到语言: ${translationResult.langage}`);
        } catch (escapeError) {
          console.error(`[${new Date().toISOString()}] 清理后 JSON 解析仍然失败:`, escapeError.message);
          throw new Error("Failed to parse AI response JSON");
        }
      }
      // 更新数据库
      console.log(`[${new Date().toISOString()}] 正在更新数据库...`);
      throwIfAborted();
      if (isPost) {
        const updatedFields = await updatePost(pool, task.postId, translationResult);
        console.log(`[${new Date().toISOString()}] 帖子数据更新完成，更新了 ${updatedFields} 个字段`);
      } else {
        const updatedFields = await updateReply(pool, task.replyId, translationResult);
        console.log(`[${new Date().toISOString()}] 回复数据更新完成，更新了 ${updatedFields} 个字段`);
      }

      // 更新任务状态为完成
      console.log(`[${new Date().toISOString()}] 正在更新任务状态为完成...`);
      throwIfAborted();
      await pool.query('UPDATE "Task" SET status = $1 WHERE id = $2', [
        "DONE",
        taskUuid,
      ]);

      await fetch(`${env.FORUM_URL}/api/task/report`, {
        method: "POST",
        body: JSON.stringify({
          password: env.PASSWORD,
          taskUuid: taskUuid,
          status: "DONE",
        }),
      });

      const endTime = Date.now();
      const duration = endTime - startTime;
      console.log(
        `[${new Date().toISOString()}] 翻译任务完成！总耗时: ${duration}ms (${(
          duration / 1000
        ).toFixed(2)}秒)`
      );
    } catch (error) {
      throw error;
    }
  };

  try {
    await taskPromise();
  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    const errorMessage =
      error && typeof error.message === "string"
        ? error.message
        : String(error);
    if (errorMessage.includes("timeout")) {
      console.error(
        `[${new Date().toISOString()}] 翻译任务超时，耗时: ${duration}ms`,
        error
      );
    } else {
      console.error(
        `[${new Date().toISOString()}] 翻译任务失败，耗时: ${duration}ms`,
        error
      );
    }

    // 更新任务状态为失败
    try {
      console.log(`[${new Date().toISOString()}] 正在更新任务状态为失败...`);
      await pool.query('UPDATE "Task" SET status = $1 WHERE id = $2', [
        "FAIL",
        taskUuid,
      ]);
      await fetch(`${env.FORUM_URL}/api/task/report`, {
        method: "POST",
        body: JSON.stringify({
          password: env.PASSWORD,
          taskUuid: taskUuid,
          status: "FAIL",
        }),
      });
    } catch (updateError) {
      console.error(
        `[${new Date().toISOString()}] 更新任务状态失败:`,
        updateError
      );
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    console.log(`[${new Date().toISOString()}] 正在关闭数据库连接...`);
    await pool.end();
  }
}

function extractJsonCandidate(rawText) {
  const text = String(rawText || "").trim().replace(/^\uFEFF/, "");
  const fencedJson = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fencedJson?.[1]) return fencedJson[1].trim();
  const fenced = text.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }
  return text;
}

async function updatePost(pool, postId, translationResult) {
  const updateFields = [];
  const updateValues = [];
  let paramIndex = 1;

  updateFields.push(`"originLang" = $${paramIndex++}`);
  updateValues.push(translationResult.langage);

  // 保存 unsafeTags
  if (translationResult.unsafeTags) {
    updateFields.push(`"unsafeTags" = $${paramIndex++}`);
    updateValues.push(JSON.stringify(translationResult.unsafeTags));
  }
  // 更新各语言的翻译内容
  const translate = translationResult.translate || {};

  if (translate["en-US"] && translate["en-US"].title && translate["en-US"].title.trim()) {
    updateFields.push(`"titleENUS" = $${paramIndex++}`);
    updateValues.push(translate["en-US"].title);
  }
  if (translate["en-US"] && translate["en-US"].content && translate["en-US"].content.trim()) {
    updateFields.push(`"contentENUS" = $${paramIndex++}`);
    updateValues.push(translate["en-US"].content);
  }

  if (translate["zh-CN"] && translate["zh-CN"].title && translate["zh-CN"].title.trim()) {
    updateFields.push(`"titleZHCN" = $${paramIndex++}`);
    updateValues.push(translate["zh-CN"].title);
  }
  if (translate["zh-CN"] && translate["zh-CN"].content && translate["zh-CN"].content.trim()) {
    updateFields.push(`"contentZHCN" = $${paramIndex++}`);
    updateValues.push(translate["zh-CN"].content);
  }

  if (translate["zh-TW"] && translate["zh-TW"].title && translate["zh-TW"].title.trim()) {
    updateFields.push(`"titleZHTW" = $${paramIndex++}`);
    updateValues.push(translate["zh-TW"].title);
  }
  if (translate["zh-TW"] && translate["zh-TW"].content && translate["zh-TW"].content.trim()) {
    updateFields.push(`"contentZHTW" = $${paramIndex++}`);
    updateValues.push(translate["zh-TW"].content);
  }

  if (translate["es-ES"] && translate["es-ES"].title && translate["es-ES"].title.trim()) {
    updateFields.push(`"titleESES" = $${paramIndex++}`);
    updateValues.push(translate["es-ES"].title);
  }
  if (translate["es-ES"] && translate["es-ES"].content && translate["es-ES"].content.trim()) {
    updateFields.push(`"contentESES" = $${paramIndex++}`);
    updateValues.push(translate["es-ES"].content);
  }

  if (translate["fr-FR"] && translate["fr-FR"].title && translate["fr-FR"].title.trim()) {
    updateFields.push(`"titleFRFR" = $${paramIndex++}`);
    updateValues.push(translate["fr-FR"].title);
  }
  if (translate["fr-FR"] && translate["fr-FR"].content && translate["fr-FR"].content.trim()) {
    updateFields.push(`"contentFRFR" = $${paramIndex++}`);
    updateValues.push(translate["fr-FR"].content);
  }

  if (translate["ru-RU"] && translate["ru-RU"].title && translate["ru-RU"].title.trim()) {
    updateFields.push(`"titleRURU" = $${paramIndex++}`);
    updateValues.push(translate["ru-RU"].title);
  }
  if (translate["ru-RU"] && translate["ru-RU"].content && translate["ru-RU"].content.trim()) {
    updateFields.push(`"contentRURU" = $${paramIndex++}`);
    updateValues.push(translate["ru-RU"].content);
  }

  if (translate["ja-JP"] && translate["ja-JP"].title && translate["ja-JP"].title.trim()) {
    updateFields.push(`"titleJAJP" = $${paramIndex++}`);
    updateValues.push(translate["ja-JP"].title);
  }
  if (translate["ja-JP"] && translate["ja-JP"].content && translate["ja-JP"].content.trim()) {
    updateFields.push(`"contentJAJP" = $${paramIndex++}`);
    updateValues.push(translate["ja-JP"].content);
  }

  if (translate["de-DE"] && translate["de-DE"].title && translate["de-DE"].title.trim()) {
    updateFields.push(`"titleDEDE" = $${paramIndex++}`);
    updateValues.push(translate["de-DE"].title);
  }
  if (translate["de-DE"] && translate["de-DE"].content && translate["de-DE"].content.trim()) {
    updateFields.push(`"contentDEDE" = $${paramIndex++}`);
    updateValues.push(translate["de-DE"].content);
  }

  if (translate["pt-BR"] && translate["pt-BR"].title && translate["pt-BR"].title.trim()) {
    updateFields.push(`"titlePTBR" = $${paramIndex++}`);
    updateValues.push(translate["pt-BR"].title);
  }
  if (translate["pt-BR"] && translate["pt-BR"].content && translate["pt-BR"].content.trim()) {
    updateFields.push(`"contentPTBR" = $${paramIndex++}`);
    updateValues.push(translate["pt-BR"].content);
  }

  if (translate["ko-KR"] && translate["ko-KR"].title && translate["ko-KR"].title.trim()) {
    updateFields.push(`"titleKOKR" = $${paramIndex++}`);
    updateValues.push(translate["ko-KR"].title);
  }
  if (translate["ko-KR"] && translate["ko-KR"].content && translate["ko-KR"].content.trim()) {
    updateFields.push(`"contentKOKR" = $${paramIndex++}`);
    updateValues.push(translate["ko-KR"].content);
  }
  updateValues.push(postId);

  const result = await pool.query(
    `UPDATE "Post" SET ${updateFields.join(", ")} WHERE id = $${paramIndex}`,
    updateValues
  );
  
  return updateFields.length;
}

async function updateReply(pool, replyId, translationResult) {
  const updateFields = [];
  const updateValues = [];
  let paramIndex = 1;

  // 保存 unsafeTags
  if (translationResult.unsafeTags) {
    updateFields.push(`"unsafeTags" = $${paramIndex++}`);
    updateValues.push(JSON.stringify(translationResult.unsafeTags));
  }

  updateFields.push(`"originLang" = $${paramIndex++}`);
  updateValues.push(translationResult.langage);  // 更新各语言的翻译内容
  const translate = translationResult.translate || {};

  if (translate["en-US"] && translate["en-US"].trim()) {
    updateFields.push(`"contentENUS" = $${paramIndex++}`);
    updateValues.push(translate["en-US"]);
  }
  if (translate["zh-CN"] && translate["zh-CN"].trim()) {
    updateFields.push(`"contentZHCN" = $${paramIndex++}`);
    updateValues.push(translate["zh-CN"]);
  }
  if (translate["zh-TW"] && translate["zh-TW"].trim()) {
    updateFields.push(`"contentZHTW" = $${paramIndex++}`);
    updateValues.push(translate["zh-TW"]);
  }
  if (translate["es-ES"] && translate["es-ES"].trim()) {
    updateFields.push(`"contentESES" = $${paramIndex++}`);
    updateValues.push(translate["es-ES"]);
  }
  if (translate["fr-FR"] && translate["fr-FR"].trim()) {
    updateFields.push(`"contentFRFR" = $${paramIndex++}`);
    updateValues.push(translate["fr-FR"]);
  }
  if (translate["ru-RU"] && translate["ru-RU"].trim()) {
    updateFields.push(`"contentRURU" = $${paramIndex++}`);
    updateValues.push(translate["ru-RU"]);
  }
  if (translate["ja-JP"] && translate["ja-JP"].trim()) {
    updateFields.push(`"contentJAJP" = $${paramIndex++}`);
    updateValues.push(translate["ja-JP"]);
  }
  if (translate["de-DE"] && translate["de-DE"].trim()) {
    updateFields.push(`"contentDEDE" = $${paramIndex++}`);
    updateValues.push(translate["de-DE"]);
  }
  if (translate["pt-BR"] && translate["pt-BR"].trim()) {
    updateFields.push(`"contentPTBR" = $${paramIndex++}`);
    updateValues.push(translate["pt-BR"]);
  }
  if (translate["ko-KR"] && translate["ko-KR"].trim()) {
    updateFields.push(`"contentKOKR" = $${paramIndex++}`);
    updateValues.push(translate["ko-KR"]);
  }
  if (updateFields.length > 0) {
    updateValues.push(replyId);

    const result = await pool.query(
      `UPDATE "Reply" SET ${updateFields.join(", ")} WHERE id = $${paramIndex}`,
      updateValues
    );
    
    return updateFields.length;
  }
  
  return 0;
}
