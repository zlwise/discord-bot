const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const PREFIX = "!";
const editSessions = new Map();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS revenus (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50),
                amount NUMERIC(10,2),
                category VARCHAR(50),
                description TEXT,
                date TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log("Table 'revenus' OK");
    } catch (err) {
        console.error("Erreur initDB:", err);
    }
}
initDB();

function parseAmount(input) {
    if (!input) return NaN;
    return parseFloat(input.replace(",", "."));
}

function formatDate(date) {
    return new Date(date).toLocaleDateString("fr-FR");
}

client.on('ready', () => {
    console.log(`Bot prêt et connecté en tant que ${client.user.tag}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const userId = message.author.id;

    if (editSessions.has(userId) && !message.content.startsWith(PREFIX)) {
        const session = editSessions.get(userId);

        if (session.step === "choose_field") {
            const choice = message.content.trim();

            const fields = {
                "1": { label: "montant", db: "amount" },
                "2": { label: "catégorie", db: "category" },
                "3": { label: "description", db: "description" },
                "4": { label: "date", db: "date" }
            };

            if (!fields[choice]) {
                return message.reply("❌ Choix invalide. Réponds avec `1`, `2`, `3` ou `4`");
            }

            session.field = fields[choice];
            session.step = "new_value";
            editSessions.set(userId, session);

            return message.reply(`✏️ Nouvelle valeur pour **${session.field.label}** ?`);
        }

        if (session.step === "new_value") {
            let finalValue = message.content.trim();

            if (session.field.db === "amount") {
                const amount = parseAmount(finalValue);
                if (isNaN(amount)) {
                    return message.reply("❌ Montant invalide. Exemple : `1500` ou `1500,50`");
                }
                finalValue = amount;
            }

            if (session.field.db === "date") {
                const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
                if (!dateRegex.test(finalValue)) {
                    return message.reply("❌ Date invalide. Format attendu : `YYYY-MM-DD`, exemple : `2026-05-29`");
                }
            }

            const oldRes = await pool.query(
                `SELECT * FROM revenus WHERE id=$1 AND user_id=$2`,
                [session.id, userId]
            );

            if (oldRes.rowCount === 0) {
                editSessions.delete(userId);
                return message.reply("❌ Revenu introuvable");
            }

            const oldData = oldRes.rows[0];

            const updateRes = await pool.query(
                `UPDATE revenus SET ${session.field.db}=$1 WHERE id=$2 AND user_id=$3 RETURNING *`,
                [finalValue, session.id, userId]
            );

            const updated = updateRes.rows[0];
            editSessions.delete(userId);

            const embed = new EmbedBuilder()
                .setTitle("✅ Revenu modifié")
                .setColor(0x00AEFF)
                .addFields(
                    {
                        name: "Avant",
                        value: `ID ${oldData.id} | ${parseFloat(oldData.amount).toFixed(2)}€ | ${oldData.category} | ${oldData.description} | ${formatDate(oldData.date)}`
                    },
                    {
                        name: "Après",
                        value: `ID ${updated.id} | ${parseFloat(updated.amount).toFixed(2)}€ | ${updated.category} | ${updated.description} | ${formatDate(updated.date)}`
                    }
                );

            return message.channel.send({ embeds: [embed] });
        }
    }

    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === "add") {
        const amount = parseAmount(args[0]);
        const category = args[1] || "autre";
        const description = args.slice(2).join(" ") || "Sans description";

        if (isNaN(amount)) return message.reply("❌ Montant invalide");

        await pool.query(
            `INSERT INTO revenus (user_id, amount, category, description) VALUES ($1,$2,$3,$4)`,
            [userId, amount, category, description]
        );

        return message.reply(`✅ Ajouté : ${amount.toFixed(2)}€ (${category})`);
    }

    if (command === "edit") {
        const id = parseInt(args[0]);

        if (isNaN(id)) {
            return message.reply("❌ ID invalide. Exemple : `!edit 4`");
        }

        const res = await pool.query(
            `SELECT * FROM revenus WHERE id=$1 AND user_id=$2`,
            [id, userId]
        );

        if (res.rowCount === 0) {
            return message.reply("❌ Revenu introuvable ou tu n'as pas le droit de le modifier");
        }

        editSessions.set(userId, {
            id,
            step: "choose_field"
        });

        return message.reply(`
Que souhaites-tu modifier ?

1️⃣ Montant
2️⃣ Catégorie
3️⃣ Description
4️⃣ Date

Réponds simplement avec : \`1\`, \`2\`, \`3\` ou \`4\`
        `);
    }

    if (command === "details") {
        const id = parseInt(args[0]);

        if (isNaN(id)) return message.reply("❌ ID invalide. Exemple : `!details 3`");

        const res = await pool.query(
            `SELECT * FROM revenus WHERE id=$1 AND user_id=$2`,
            [id, userId]
        );

        if (res.rowCount === 0) return message.reply("❌ Revenu introuvable");

        const r = res.rows[0];

        const embed = new EmbedBuilder()
            .setTitle(`📄 Détail du revenu ID ${r.id}`)
            .setColor(0x00AEFF)
            .addFields(
                { name: "Montant", value: `${parseFloat(r.amount).toFixed(2)}€`, inline: true },
                { name: "Catégorie", value: r.category || "autre", inline: true },
                { name: "Date", value: formatDate(r.date), inline: true },
                { name: "Description", value: r.description || "Sans description", inline: false }
            );

        return message.channel.send({ embeds: [embed] });
    }

    if (command === "total") {
        const category = args[0];
        let query = `SELECT SUM(amount) as total FROM revenus WHERE user_id=$1`;
        let params = [userId];

        if (category) {
            query += ` AND category=$2`;
            params.push(category);
        }

        const res = await pool.query(query, params);
        const total = parseFloat(res.rows[0].total) || 0;

        return message.reply(`💰 Ton total ${category || "global"} : ${total.toFixed(2)}€`);
    }

    if (command === "month") {
        const now = new Date();
        const res = await pool.query(`SELECT amount, date FROM revenus WHERE user_id=$1`, [userId]);

        const filtered = res.rows.filter(r => {
            const d = new Date(r.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        const total = filtered.reduce((sum, r) => sum + parseFloat(r.amount), 0);

        return message.reply(`📅 Ton total ce mois : ${total.toFixed(2)}€`);
    }

    if (command === "list") {
        const res = await pool.query(
            `SELECT * FROM revenus WHERE user_id=$1 ORDER BY category ASC, id ASC`,
            [userId]
        );

        const revenus = res.rows;

        if (revenus.length === 0) return message.reply("📭 Aucun revenu");

        const embed = new EmbedBuilder()
            .setTitle("📜 Tes revenus par catégorie")
            .setColor(0x00AEFF);

        const categories = {};

        revenus.forEach(r => {
            const category = r.category || "autre";

            if (!categories[category]) {
                categories[category] = {
                    total: 0,
                    items: []
                };
            }

            const amount = parseFloat(r.amount) || 0;
            categories[category].total += amount;

            categories[category].items.push(
                `🔹 ID ${r.id} | ${amount.toFixed(2)}€ | ${r.description} | ${formatDate(r.date)}`
            );
        });

        for (const [category, data] of Object.entries(categories)) {
            embed.addFields({
                name: `📂 ${category} — Total : ${data.total.toFixed(2)}€`,
                value: data.items.join("\n"),
                inline: false
            });
        }

        return message.channel.send({ embeds: [embed] });
    }

    if (command === "reset") {
        await pool.query(`DELETE FROM revenus WHERE user_id=$1`, [userId]);
        return message.reply("🗑️ Tous TES revenus ont été supprimés");
    }

    if (command === "help") {
        const embed = new EmbedBuilder()
            .setTitle("📊 Bot gestion de revenus")
            .setColor(0x00AEFF)
            .setDescription(`
➕ !add montant catégorie description
📜 !list
📄 !details ID
✏️ !edit ID
💰 !total [catégorie]
📅 !month
🧹 !reset
❓ !help

Exemples :
!add 1500 salaire Salaire mai
!details 3
!edit 3
            `);

        return message.channel.send({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);
