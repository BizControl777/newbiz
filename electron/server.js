import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import nodeMachineId from "node-machine-id";
const { machineIdSync } = nodeMachineId;
import axios from "axios";

dotenv.config();

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Usar Service Role no servidor intermediário
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "seu_segredo_jwt_muito_seguro_aqui";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "chave_mestra_bizcontrol";

// Helper para ID de máquina
const getDeviceId = () => {
  try {
    return machineIdSync();
  } catch (e) {
    return "unknown-device";
  }
};

// Helper para contar funcionários locais
const getLocalEmployeesCount = () => {
  return new Promise((resolve) => {
    db.get("SELECT COUNT(*) as total FROM usuarios", [], (err, row) => {
      if (err) {
        console.error("[COUNT] Erro ao contar funcionários:", err.message);
        resolve(0);
      } else {
        resolve(row.total || 0);
      }
    });
  });
};

// Middleware de Verificação de Licença (para uso no ERP Local)
const checkLocalLicense = (req, res, next) => {
  // Ignorar rotas de login, api de licença e estáticos
  if (req.path === "/health" || req.path.startsWith("/api/auth") || req.path.startsWith("/api/license") || req.path === "/api/login" || req.path.startsWith("/api/activate") || req.path.startsWith("/api/validate")) {
    return next();
  }

  db.get("SELECT * FROM local_license LIMIT 1", [], (err, license) => {
    if (err || !license) {
      return res.status(403).json({ message: "Licença não encontrada. Ative o sistema.", code: "NO_LICENSE" });
    }

    if (license.status === "blocked") {
      return res.status(403).json({ message: "Sua licença está bloqueada. Contacte o suporte.", code: "LICENSE_BLOCKED" });
    }

    if (new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ message: "Sua licença expirou.", code: "LICENSE_EXPIRED" });
    }

    // Bloqueio parcial após 10 dias sem validação
    const dezDias = 10 * 24 * 60 * 60 * 1000;
    const tempoSemValidar = new Date() - new Date(license.last_validation_at);

    // Permitir apenas GET (visualizar dados) em bloqueio parcial
    const isCriticalRoute = req.method !== "GET";

    if (tempoSemValidar > dezDias) {
      if (isCriticalRoute) {
        return res.status(403).json({ 
          message: "Sua licença precisa ser validada. Conecte-se à internet para continuar realizando operações críticas (vendas, cadastros, etc).", 
          code: "VALIDATION_REQUIRED" 
        });
      }
      // Se for GET, permitimos, mas podemos adicionar um header ou info de que está em modo limitado
    }

    next();
  });
};

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Aplicar checkLocalLicense apenas se não estivermos no modo "Licensing Server"
if (!process.env.IS_LICENSING_SERVER) {
  app.use(checkLocalLicense);
}

// ... rest of setup ...

// Resolve DB path and ensure directory/file exist to avoid SQLITE_CANTOPEN
const defaultDbPath = path.resolve(path.join(__dirname, "..", "data", "bizcontrol.db"));
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDbPath;

try {
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });
  // Ensure the DB file exists (open with append flag creates if missing)
  const fd = fs.openSync(dbPath, "a");
  fs.closeSync(fd);
  try {
    fs.chmodSync(dbPath, 0o644);
  } catch (e) {
    // Non-fatal: permission change may fail on some filesystems
  }
} catch (err) {
  console.error("Erro ao criar diretório/ficheiro do DB:", err);
}

// Inicializar banco de dados
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Erro ao conectar ao banco de dados:", err);
  } else {
    console.log("✓ Banco de dados conectado ->", dbPath);
    initDatabase();
  }
});

// Inicializar tabelas
function initDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS local_license (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_key TEXT,
        device_id TEXT,
        company_name TEXT,
        status TEXT,
        expires_at DATETIME,
        last_validation_at DATETIME,
        next_validation_at DATETIME
      )
    `);

    // Tabela de usuários
    db.run(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        role TEXT DEFAULT 'vendedor',
        empresa_id INTEGER,
        ativo INTEGER DEFAULT 1,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de empresas
    db.run(`
      CREATE TABLE IF NOT EXISTS empresas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        cnpj TEXT UNIQUE,
        endereco TEXT,
        telefone TEXT,
        email TEXT,
        ativo INTEGER DEFAULT 1,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de categorias
    db.run(`
      CREATE TABLE IF NOT EXISTS categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        empresa_id INTEGER,
        ativo INTEGER DEFAULT 1
      )
    `);

    // Tabela de produtos
    db.run(`
      CREATE TABLE IF NOT EXISTS produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        categoria_id INTEGER,
        empresa_id INTEGER,
        preco_venda REAL NOT NULL,
        preco_custo REAL NOT NULL,
        stock REAL DEFAULT 0,
        stock_minimo REAL DEFAULT 10,
        ativo INTEGER DEFAULT 1,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(categoria_id) REFERENCES categorias(id),
        FOREIGN KEY(empresa_id) REFERENCES empresas(id)
      )
    `);

    // Tabela de vendas
    db.run(`
      CREATE TABLE IF NOT EXISTS vendas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        empresa_id INTEGER,
        total REAL NOT NULL,
        status TEXT DEFAULT 'concluida',
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id),
        FOREIGN KEY(empresa_id) REFERENCES empresas(id)
      )
    `);

    // Tabela de itens de venda
    db.run(`
      CREATE TABLE IF NOT EXISTS itens_venda (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venda_id INTEGER,
        produto_id INTEGER,
        quantidade REAL NOT NULL,
        preco_unitario REAL NOT NULL,
        total REAL NOT NULL,
        FOREIGN KEY(venda_id) REFERENCES vendas(id),
        FOREIGN KEY(produto_id) REFERENCES produtos(id)
      )
    `);

    // Tabela de movimentações de stock
    db.run(`
      CREATE TABLE IF NOT EXISTS movimentacoes_stock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id INTEGER,
        empresa_id INTEGER,
        tipo TEXT,
        quantidade REAL,
        usuario_id INTEGER,
        descricao TEXT,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(produto_id) REFERENCES produtos(id),
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id),
        FOREIGN KEY(empresa_id) REFERENCES empresas(id)
      )
    `);

    // Tabela de reservas
    db.run(`
      CREATE TABLE IF NOT EXISTS reservas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        produto_id INTEGER,
        empresa_id INTEGER,
        quantidade REAL NOT NULL,
        titular TEXT,
        bi TEXT,
        status TEXT DEFAULT 'Activa',
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        atualizado_em DATETIME,
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id),
        FOREIGN KEY(produto_id) REFERENCES produtos(id),
        FOREIGN KEY(empresa_id) REFERENCES empresas(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS caixas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER,
        usuario_abertura_id INTEGER,
        usuario_fechamento_id INTEGER,
        valor_inicial REAL DEFAULT 0,
        valor_fechamento REAL DEFAULT 0,
        valor_esperado REAL DEFAULT 0,
        diferenca REAL DEFAULT 0,
        status TEXT DEFAULT 'aberto',
        aberto_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        fechado_em DATETIME,
        observacoes TEXT,
        FOREIGN KEY(empresa_id) REFERENCES empresas(id),
        FOREIGN KEY(usuario_abertura_id) REFERENCES usuarios(id),
        FOREIGN KEY(usuario_fechamento_id) REFERENCES usuarios(id)
      )
    `);

    migrateProdutosColumns();
    migrateVendasColumns();
    migrateEmpresasColumns();
    migrateUsuariosColumns();
    migrateReservasColumns();
    migrateCaixasColumns();
    createFinanceiroTable();

    // Inserir dados demo
    db.all("SELECT COUNT(*) as count FROM usuarios", [], (err, rows) => {
      if (rows && rows[0].count === 0) {
        insertDemoData();
      }
    });
  });
}

function migrateProdutosColumns() {
  const columns = [
    ["unidade_medida", "TEXT DEFAULT 'Unidade'"],
    ["qtd_por_caixa", "INTEGER DEFAULT 1"],
    ["preco_compra_caixa", "REAL DEFAULT 0"],
    ["preco_venda_caixa", "REAL DEFAULT 0"],
    ["tamanho", "TEXT"],
    ["marca", "TEXT"],
    ["descricao", "TEXT"],
    ["codigo_barras", "TEXT"],
    ["tipo_produto", "TEXT DEFAULT 'Unidade'"],
    ["lote", "TEXT"],
    ["data_fabricacao", "DATE"],
    ["data_validade", "DATE"],
  ];
  columns.forEach(([name, type]) => {
    db.run(`ALTER TABLE produtos ADD COLUMN ${name} ${type}`, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        // coluna já existe — ignorar
      }
    });
  });
}

function migrateVendasColumns() {
  const columns = [
    ["metodo_pagamento", "TEXT DEFAULT 'dinheiro'"],
    ["status_pagamento", "TEXT DEFAULT 'pago'"],
    ["cliente_nome", "TEXT DEFAULT 'Cliente balcão'"],
    ["cliente_contacto", "TEXT"],
    ["valor_recebido", "REAL DEFAULT 0"],
    ["troco", "REAL DEFAULT 0"],
    ["caixa_id", "INTEGER"],
  ];
  columns.forEach(([name, type]) => {
    db.run(`ALTER TABLE vendas ADD COLUMN ${name} ${type}`, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        console.warn(`Falha ao migrar vendas.${name}:`, err.message);
      }
    });
  });
}

function migrateCaixasColumns() {
  const columns = [
    ["empresa_id", "INTEGER"],
    ["usuario_abertura_id", "INTEGER"],
    ["usuario_fechamento_id", "INTEGER"],
    ["valor_inicial", "REAL DEFAULT 0"],
    ["valor_fechamento", "REAL DEFAULT 0"],
    ["valor_esperado", "REAL DEFAULT 0"],
    ["diferenca", "REAL DEFAULT 0"],
    ["status", "TEXT DEFAULT 'aberto'"],
    ["aberto_em", "DATETIME DEFAULT CURRENT_TIMESTAMP"],
    ["fechado_em", "DATETIME"],
    ["observacoes", "TEXT"],
  ];
  columns.forEach(([name, type]) => {
    db.run(`ALTER TABLE caixas ADD COLUMN ${name} ${type}`, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        // ignorar
      }
    });
  });
}

function createFinanceiroTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS transacoes_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      usuario_id INTEGER,
      tipo TEXT,
      categoria TEXT,
      valor REAL,
      metodo_pagamento TEXT,
      data DATETIME DEFAULT CURRENT_TIMESTAMP,
      entidade_nome TEXT,
      observacao TEXT,
      FOREIGN KEY(empresa_id) REFERENCES empresas(id),
      FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )
  `);
}

function migrateEmpresasColumns() {
  const columns = [
    ["plano", "TEXT DEFAULT 'Mensal'"],
    ["data_expiracao", "DATETIME"],
    ["background_image", "TEXT"],
    ["bi", "TEXT"],
    ["empresario_nome", "TEXT"],
  ];
  columns.forEach(([name, type]) => {
    db.run(`ALTER TABLE empresas ADD COLUMN ${name} ${type}`, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        // ignorar
      }
    });
  });
}

function migrateUsuariosColumns() {
  const columns = [
    ["permissoes", "TEXT"], // JSON array
  ];
  columns.forEach(([name, type]) => {
    db.run(`ALTER TABLE usuarios ADD COLUMN ${name} ${type}`, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        // ignorar
      }
    });
  });
}

function migrateReservasColumns() {
  const columns = [
    ["titular", "TEXT"],
    ["bi", "TEXT"],
  ];
  columns.forEach(([name, type]) => {
    db.run(`ALTER TABLE reservas ADD COLUMN ${name} ${type}`, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        // ignorar
      }
    });
  });
}

function resolveCategoriaId(categoria_id, empresaId, callback) {
  if (!categoria_id) return callback(null, null);
  if (typeof categoria_id === "number" || /^\d+$/.test(String(categoria_id))) {
    return callback(null, Number(categoria_id));
  }
  const nome = String(categoria_id).trim();
  db.get("SELECT id FROM categorias WHERE nome = ? AND empresa_id = ?", [nome, empresaId], (err, row) => {
    if (row) return callback(null, row.id);
    db.run("INSERT INTO categorias (nome, empresa_id) VALUES (?, ?)", [nome, empresaId], function (insErr) {
      if (insErr) return callback(insErr);
      callback(null, this.lastID);
    });
  });
}

// Inserir dados de demonstração
function insertDemoData() {
  const hashedPassword = bcrypt.hashSync("demo123", 10);

  db.run("INSERT INTO empresas (nome, cnpj, endereco, telefone, email) VALUES (?, ?, ?, ?, ?)", [
    "BizControl Demo",
    "12345678000100",
    "Maputo, Moçambique",
    "+258123456789",
    "contact@bizcontrol.local",
  ]);

  db.all("SELECT id FROM empresas LIMIT 1", [], (err, rows) => {
    if (rows && rows[0]) {
      const empresaId = rows[0].id;

      db.run(
        "INSERT INTO usuarios (nome, email, senha, role, empresa_id) VALUES (?, ?, ?, ?, ?)",
        ["Admin", "admin@bizcontrol.local", hashedPassword, "super", empresaId]
      );

      db.run(
        "INSERT INTO usuarios (nome, email, senha, role, empresa_id) VALUES (?, ?, ?, ?, ?)",
        ["Gestor", "gestor@bizcontrol.local", hashedPassword, "gestor", empresaId]
      );

      db.run(
        "INSERT INTO usuarios (nome, email, senha, role, empresa_id) VALUES (?, ?, ?, ?, ?)",
        ["Vendedor", "vendedor@bizcontrol.local", hashedPassword, "vendedor", empresaId]
      );

      // Categorias
      const categorias = ["Bebidas", "Alimentos", "Higiene", "Electrónica"];
      categorias.forEach((cat) => {
        db.run("INSERT INTO categorias (nome, empresa_id) VALUES (?, ?)", [cat, empresaId]);
      });

      console.log("✓ Dados de demonstração inseridos");
    }
  });
}

// Middleware de autenticação
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Token não fornecido" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.role = decoded.role;
    req.empresaId = decoded.empresaId;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Token inválido" });
  }
}

// ===== SISTEMA DE LICENCIAMENTO (SUPABASE / HYBRID) =====

// ATIVAÇÃO (Chamado pelo ERP para ativar uma chave)
app.post("/api/activate", async (req, res) => {
  const { license_key, company_name, phone } = req.body;
  const device_id = getDeviceId();
  const ip = req.ip;

  console.log(`[LICENSE] Tentativa de ativação: Key=${license_key}, Device=${device_id}, IP=${ip}`);

  if (!license_key) return res.status(400).json({ message: "Chave de licença obrigatória" });

  try {
    if (process.env.IS_LICENSING_SERVER && supabase) {
      // 1. Verificar se a licença existe
      const { data: license, error } = await supabase
        .from("licenses")
        .select("*")
        .eq("license_key", license_key)
        .single();

      if (error || !license) {
        console.warn(`[LICENSE] Licença inválida tentada: ${license_key}`);
        return res.status(404).json({ message: "Chave de licença não encontrada ou inválida." });
      }

      // 2. Verificar se já está ativada em outro dispositivo
      if (license.device_id && license.device_id !== device_id) {
        console.warn(`[LICENSE] Conflito de Device ID: Key=${license_key}, Existing=${license.device_id}, New=${device_id}`);
        return res.status(403).json({ message: "Esta licença já está vinculada a outro computador." });
      }

      // 3. Calcular datas
      const isYearly = license.plan === "yearly";
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + (isYearly ? 365 : 30));
      
      const nextValidation = new Date();
      nextValidation.setDate(nextValidation.getDate() + 10);

      // 4. Atualizar Supabase
      const { error: updError } = await supabase
        .from("licenses")
        .update({
          device_id,
          company_name: company_name || license.company_name,
          phone: phone || license.phone,
          status: "active",
          activated_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
          last_validation_at: new Date().toISOString(),
          next_validation_at: nextValidation.toISOString(),
          last_ip: ip
        })
        .eq("license_key", license_key);

      if (updError) throw updError;

      console.log(`[LICENSE] Ativação bem-sucedida: ${license_key} -> ${device_id}`);

      return res.json({
        status: "active",
        expires_at: expiresAt.toISOString(),
        next_validation_at: nextValidation.toISOString()
      });
    } else {
      // MODO CLIENTE: Repassar para o servidor de licenciamento
      const apiUrl = process.env.REMOTE_LICENSE_API_URL;
      if (!apiUrl) return res.status(500).json({ message: "Configuração de servidor remoto ausente." });

      const response = await axios.post(`${apiUrl}/api/activate`, {
        license_key, company_name, phone, device_id
      });

      const { status, expires_at, next_validation_at } = response.data;
      
      // Guardar localmente para funcionamento offline
      db.run(`
        INSERT OR REPLACE INTO local_license 
        (id, license_key, device_id, company_name, status, expires_at, last_validation_at, next_validation_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        [license_key, device_id, company_name, status, expires_at, new Date().toISOString(), next_validation_at]
      );

      return res.json(response.data);
    }
  } catch (err) {
    console.error("[LICENSE] Erro na ativação:", err.message);
    res.status(500).json({ message: "Erro ao processar ativação: " + (err.response?.data?.message || err.message) });
  }
});

// VALIDAÇÃO PERIÓDICA
app.post("/api/validate", async (req, res) => {
  const { license_key, version } = req.body;
  const device_id = getDeviceId();
  const ip = req.ip;

  try {
    if (process.env.IS_LICENSING_SERVER && supabase) {
      const { data: license, error } = await supabase
        .from("licenses")
        .select("*")
        .eq("license_key", license_key)
        .single();

      if (error || !license) return res.status(404).json({ message: "Licença inválida" });
      
      // Segurança: Validar Device ID
      if (license.device_id && license.device_id !== device_id) {
        return res.status(403).json({ message: "Este dispositivo não tem permissão para usar esta licença." });
      }

      if (license.status === "blocked") {
        return res.json({ status: "blocked", message: "Esta licença foi bloqueada pelo administrador." });
      }

      // Verificar expiração
      if (new Date(license.expires_at) < new Date()) {
        await supabase.from("licenses").update({ status: "expired" }).eq("license_key", license_key);
        return res.json({ status: "expired", message: "Sua licença expirou." });
      }

      const nextValidation = new Date();
      nextValidation.setDate(nextValidation.getDate() + 10);

      const totalEmployees = await getLocalEmployeesCount();

      await supabase
        .from("licenses")
        .update({
          last_validation_at: new Date().toISOString(),
          next_validation_at: nextValidation.toISOString(),
          version: version || license.version,
          last_ip: ip,
          device_id: device_id,
          total_employees: totalEmployees
        })
        .eq("license_key", license_key);

      return res.json({
        status: license.status,
        expires_at: license.expires_at,
        next_validation_at: nextValidation.toISOString()
      });
    } else {
      // MODO CLIENTE: Tentar validar com o servidor remoto
      const apiUrl = process.env.REMOTE_LICENSE_API_URL;
      let statusData;

      try {
        const response = await axios.post(`${apiUrl}/api/validate`, { license_key, device_id, version });
        statusData = response.data;
        
        // Atualizar cache local
        db.run(`
          UPDATE local_license SET 
          status = ?, expires_at = ?, last_validation_at = ?, next_validation_at = ?
          WHERE license_key = ?`,
          [statusData.status, statusData.expires_at, new Date().toISOString(), statusData.next_validation_at, license_key]
        );
      } catch (err) {
        // Fallback local se estiver offline (Permitido por até 10 dias pelo middleware checkLocalLicense)
        const license = await new Promise((resolve) => {
          db.get("SELECT * FROM local_license WHERE license_key = ?", [license_key], (e, row) => resolve(row));
        });

        if (!license) return res.status(404).json({ message: "Licença não encontrada localmente. Conecte-se à internet." });
        
        statusData = {
          status: license.status,
          expires_at: license.expires_at,
          next_validation_at: license.next_validation_at,
          offline: true
        };
      }

      return res.json(statusData);
    }
  } catch (err) {
    console.error("[LICENSE] Erro na validação:", err.message);
    res.status(500).json({ message: "Erro na validação" });
  }
});

// BLOQUEIO/DESBLOQUEIO (ADMIN)
app.post("/api/block", async (req, res) => {
  const { license_key, api_key, status } = req.body;
  const newStatus = status === "active" ? "active" : "blocked";

  if (api_key !== ADMIN_API_KEY) {
    console.warn(`[SECURITY] Tentativa de acesso não autorizado ao endpoint de bloqueio. IP=${req.ip}`);
    return res.status(401).json({ message: "Acesso negado. Chave de API inválida." });
  }

  try {
    if (process.env.IS_LICENSING_SERVER && supabase) {
      const { error } = await supabase
        .from("licenses")
        .update({ status: newStatus })
        .eq("license_key", license_key);
      
      if (error) throw error;
      
      console.log(`[LICENSE] Status da licença ${license_key} alterado para ${newStatus} via Admin.`);
      res.json({ message: `Licença ${newStatus === "active" ? "desbloqueada" : "bloqueada"} com sucesso` });
    } else {
      // MODO CLIENTE: Repassar para o servidor de licenciamento
      const apiUrl = process.env.REMOTE_LICENSE_API_URL;
      if (!apiUrl) return res.status(500).json({ message: "Configuração de servidor remoto ausente." });

      const response = await axios.post(`${apiUrl}/api/block`, { license_key, api_key, status: newStatus });
      res.json(response.data);
    }
  } catch (err) {
    console.error("[LICENSE] Erro ao alterar status da licença:", err.message);
    res.status(500).json({ message: "Erro ao processar alteração de status" });
  }
});

// GET STATUS LOCAL
app.get("/api/license/status", (req, res) => {
  db.get("SELECT * FROM local_license LIMIT 1", [], (err, row) => {
    if (err) {
      console.error("[LICENSE] Erro ao buscar status local:", err);
      return res.status(500).json({ message: "Erro ao buscar licença" });
    }
    const status = row || { status: "none" };
    console.log("[LICENSE] Status local solicitado:", status.status, row ? `(Key: ${row.license_key})` : "(Sem licença)");
    res.json(status);
  });
});

// LISTAR LICENÇAS (SUPER ADMIN)
app.get("/api/super/licenses", verifyToken, async (req, res) => {
  if (req.role !== "super") return res.status(403).json({ message: "Acesso negado" });

  try {
    if (process.env.IS_LICENSING_SERVER && supabase) {
      const { data, error } = await supabase.from("licenses").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data);
    } else {
      const apiUrl = process.env.REMOTE_LICENSE_API_URL;
      const response = await axios.get(`${apiUrl}/api/super/licenses`, {
        params: { api_key: ADMIN_API_KEY }
      });
      res.json(response.data);
    }
  } catch (err) {
    res.status(500).json({ message: "Erro ao listar licenças" });
  }
});

// ===== ROTAS DE AUTENTICAÇÃO =====
app.post("/api/auth/login", async (req, res) => {
  const { email, senha, isOnline } = req.body;

  try {
    let user = null;

    // 1. TENTATIVA DE LOGIN ONLINE (Prioritário se houver internet)
    if (isOnline && supabase) {
      console.log("ONLINE LOGIN");
      
      // Consultar Supabase na tabela 'licenses' conforme nova estrutura
      const { data: license, error: supaError } = await supabase
        .from("licenses")
        .select("*")
        .eq("login_email", email)
        .single();

      if (license && !supaError) {
        console.log("USER FOUND IN SUPABASE (LICENSES TABLE)");

        // Verificar se a licença está bloqueada
        if (license.status === "blocked") {
          return res.status(403).json({ message: "Esta licença está bloqueada. Contacte o suporte." });
        }
        
        // Verificar senha (login_password)
        const senhaHash = license.login_password;
        if (!senhaHash) {
          return res.status(401).json({ message: "Utilizador sem senha configurada no Supabase." });
        }

        // Suporte Híbrido: Bcrypt ou Texto Limpo (para migração automática)
        const isBcrypt = senhaHash.startsWith("$2b$") || senhaHash.startsWith("$2a$");
        let passwordValid = false;

        if (isBcrypt) {
          passwordValid = bcrypt.compareSync(senha, senhaHash);
        } else {
          // Se não for bcrypt, comparamos texto limpo diretamente
          passwordValid = (senha === senhaHash);
          
          // AUTO-MIGRAÇÃO: Se a senha em texto limpo estiver correta, convertemos para Bcrypt no Supabase agora mesmo
          if (passwordValid) {
            console.log(`[AUTH] Migrando senha de texto limpo para Bcrypt para: ${email}`);
            const newHash = bcrypt.hashSync(senha, 10);
            await supabase.from("licenses").update({ login_password: newHash }).eq("login_email", email);
            // Usamos o novo hash para a sincronização local abaixo
            license.login_password = newHash;
          }
        }
        
        if (passwordValid) {
          // SINCRONIZAÇÃO: Garantir que a empresa existe localmente
          const empresaId = await new Promise((resolve) => {
            db.get("SELECT id FROM empresas WHERE nome = ?", [license.company_name], (err, row) => {
              if (row) resolve(row.id);
              else {
                db.run("INSERT INTO empresas (nome, email, telefone, ativo) VALUES (?, ?, ?, ?)",
                  [license.company_name, license.login_email, license.phone, 1],
                  function() { resolve(this.lastID); }
                );
              }
            });
          });

          // SINCRONIZAÇÃO: Atualizar cache do utilizador
          const currentHash = license.login_password; // Pode ter sido atualizado na auto-migração
          const perms = JSON.stringify(["admin", "all"]);
          
          // HEARTBEAT: Atualizar Supabase com dados do hardware e acesso
          const currentDeviceId = getDeviceId();
          const currentIp = req.ip;
          const totalEmployees = await getLocalEmployeesCount();
          
          if (supabase) {
            await supabase
              .from("licenses")
              .update({
                last_validation_at: new Date().toISOString(),
                device_id: currentDeviceId,
                last_ip: currentIp,
                total_employees: totalEmployees
              })
              .eq("license_key", license.license_key);
            console.log(`[HEARTBEAT] Atualizado via Login: ${license.license_key} (Funcionários: ${totalEmployees})`);
          }
          
          await new Promise((resolve) => {
            db.run(`
              INSERT INTO usuarios (nome, email, senha, role, empresa_id, ativo, permissoes)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET
              nome=excluded.nome, senha=excluded.senha, role=excluded.role, 
              empresa_id=excluded.empresa_id, ativo=excluded.ativo, permissoes=excluded.permissoes`,
              [license.owner_name || license.company_name, license.login_email, currentHash, "gestor", empresaId, 1, perms],
              (err) => {
                if (err) console.error("[SYNC] Erro ao atualizar cache local:", err.message);
                else console.log("[SYNC] Dados locais atualizados com sucesso");
                resolve();
              }
            );
          });

          // Preparar objeto do utilizador para a resposta
          user = {
            id: email, // Usamos o email como ID temporário ou buscamos o ID inserido
            nome: license.owner_name || license.company_name,
            email: license.login_email,
            role: "gestor",
            empresa_id: empresaId,
            permissoes: ["admin", "all"]
          };
        } else {
          return res.status(401).json({ message: "Senha incorreta no Supabase" });
        }
      } else if (supaError && supaError.code !== 'PGRST116') {
        console.warn("[ONLINE] Erro ao conectar ao Supabase, tentando fallback offline...");
      } else if (!license) {
        console.log("USER NOT FOUND IN SUPABASE");
        // Não retornar erro aqui, permitir tentar offline caso o utilizador já exista localmente
      }
    }

    // 2. TENTATIVA DE LOGIN OFFLINE (Fallback ou Sem Internet)
    if (!user) {
      console.log("OFFLINE LOGIN");
      
      return db.get("SELECT * FROM usuarios WHERE email = ? AND ativo = 1", [email], (err, localUser) => {
        if (err || !localUser) {
          console.log("USER NOT FOUND");
          return res.status(401).json({ message: "Sem dados locais disponíveis para este email. Conecte-se à internet para o primeiro acesso." });
        }

        console.log("USER FOUND IN LOCAL CACHE");
        
        const passwordValid = bcrypt.compareSync(senha, localUser.senha);
        if (!passwordValid) {
          return res.status(401).json({ message: "Senha incorreta (Modo Offline)" });
        }

        user = localUser;
        return finalizeLogin(user, res);
      });
    }

    // Se logou online com sucesso
    if (user) {
      return finalizeLogin(user, res);
    }

  } catch (error) {
    console.error("[LOGIN ERROR]", error);
    res.status(500).json({ message: "Erro ao processar login: " + error.message });
  }
});

function finalizeLogin(user, res) {
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, empresaId: user.empresa_id },
    JWT_SECRET,
    { expiresIn: "24h" }
  );

  res.json({
    token,
    user: {
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role,
      empresa_id: user.empresa_id,
      permissoes: typeof user.permissoes === 'string' ? JSON.parse(user.permissoes) : (user.permissoes || [])
    },
  });
}

// ===== ROTAS DE CATEGORIAS =====
app.get("/api/categorias", verifyToken, (req, res) => {
  db.all("SELECT id, nome FROM categorias WHERE empresa_id = ? AND ativo = 1 ORDER BY nome", [req.empresaId], (err, rows) => {
    if (err) return res.status(500).json({ message: "Erro ao buscar categorias" });
    res.json(rows);
  });
});

app.post("/api/categorias", verifyToken, (req, res) => {
  const { nome } = req.body;
  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ message: "Nome da categoria é obrigatório" });
  }
  db.get("SELECT id FROM categorias WHERE nome = ? AND empresa_id = ?", [nome.trim(), req.empresaId], (err, row) => {
    if (row) return res.json({ id: row.id, message: "Categoria já existe" });
    db.run("INSERT INTO categorias (nome, empresa_id) VALUES (?, ?)", [nome.trim(), req.empresaId], function (insErr) {
      if (insErr) return res.status(500).json({ message: "Erro ao criar categoria" });
      res.json({ id: this.lastID, message: "Categoria criada com sucesso" });
    });
  });
});

// ===== ROTAS DE PRODUTOS =====
const PRODUTOS_SELECT = `
  SELECT p.*, c.nome AS categoria_nome
  FROM produtos p
  LEFT JOIN categorias c ON p.categoria_id = c.id
  WHERE p.empresa_id = ? AND p.ativo = 1
  ORDER BY p.nome
`;

app.get("/api/produtos", verifyToken, (req, res) => {
  db.all(PRODUTOS_SELECT, [req.empresaId], (err, rows) => {
    if (err) return res.status(500).json({ message: "Erro ao buscar produtos" });
    res.json(rows);
  });
});

app.post("/api/produtos", verifyToken, (req, res) => {
  const {
    nome,
    tipo_produto,
    categoria_id,
    preco_venda,
    preco_custo,
    stock_minimo,
    stock,
    unidade_medida,
    qtd_por_caixa,
    preco_compra_caixa,
    preco_venda_caixa,
    tamanho,
    marca,
    descricao,
    codigo_barras,
  } = req.body;

  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ message: "Nome do produto é obrigatório" });
  }

  const custo = Number(preco_custo ?? 0);
  const venda = Number(preco_venda ?? 0);
  if (venda <= 0) {
    return res.status(400).json({ message: "Preço de venda deve ser maior que zero" });
  }
  if (custo > 0 && venda < custo) {
    return res.status(400).json({ message: "Margem negativa bloqueada: preço de venda abaixo do custo" });
  }

  resolveCategoriaId(categoria_id, req.empresaId, (catErr, catId) => {
    if (catErr) return res.status(500).json({ message: "Erro ao resolver categoria" });

    const qtdCx = Math.max(1, Number(qtd_por_caixa) || 1);
    const precoCx = Number(preco_venda_caixa) || venda * qtdCx;
    const compraCx = Number(preco_compra_caixa) || custo * qtdCx;

    db.run(
      `INSERT INTO produtos (
        nome, tipo_produto, categoria_id, empresa_id, preco_venda, preco_custo, stock, stock_minimo,
        unidade_medida, qtd_por_caixa, preco_compra_caixa, preco_venda_caixa, tamanho, marca, descricao, codigo_barras
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nome.trim(),
        tipo_produto || "Unidade",
        catId,
        req.empresaId,
        venda,
        custo,
        Number(stock) || 0,
        Number(stock_minimo) ?? 10,
        unidade_medida || "Unidade",
        qtdCx,
        compraCx,
        precoCx,
        tamanho || null,
        marca || null,
        descricao || null,
        codigo_barras || null,
      ],
      function (err) {
        if (err) return res.status(500).json({ message: "Erro ao criar produto: " + err.message });
        res.json({ id: this.lastID, message: "Produto criado com sucesso" });
      }
    );
  });
});

app.put("/api/produtos/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  const body = req.body;

  db.get("SELECT * FROM produtos WHERE id = ? AND empresa_id = ?", [id, req.empresaId], (err, produto) => {
    if (err || !produto) return res.status(404).json({ message: "Produto não encontrado" });

    const applyUpdate = (catId) => {
      const nome = body.nome != null ? body.nome : produto.nome;
      const tipo_produto = body.tipo_produto != null ? body.tipo_produto : produto.tipo_produto;
      const preco_venda = body.preco_venda != null ? Number(body.preco_venda) : produto.preco_venda;
      const preco_custo = body.preco_custo != null ? Number(body.preco_custo) : produto.preco_custo;
      const stock = body.stock != null ? Number(body.stock) : produto.stock;
      const stock_minimo = body.stock_minimo != null ? Number(body.stock_minimo) : produto.stock_minimo;
      const categoria_id = catId != null ? catId : produto.categoria_id;
      const unidade_medida = body.unidade_medida ?? produto.unidade_medida;
      const qtd_por_caixa = body.qtd_por_caixa != null ? Math.max(1, Number(body.qtd_por_caixa)) : produto.qtd_por_caixa;
      const preco_compra_caixa = body.preco_compra_caixa != null ? Number(body.preco_compra_caixa) : produto.preco_compra_caixa;
      const preco_venda_caixa = body.preco_venda_caixa != null ? Number(body.preco_venda_caixa) : produto.preco_venda_caixa;
      const tamanho = body.tamanho !== undefined ? body.tamanho : produto.tamanho;
      const marca = body.marca !== undefined ? body.marca : produto.marca;
      const descricao = body.descricao !== undefined ? body.descricao : produto.descricao;
      const codigo_barras = body.codigo_barras !== undefined ? body.codigo_barras : produto.codigo_barras;

      if (preco_venda <= 0) {
        return res.status(400).json({ message: "Preço de venda deve ser maior que zero" });
      }
      if (preco_custo > 0 && preco_venda < preco_custo) {
        return res.status(400).json({ message: "Margem negativa bloqueada: preço de venda abaixo do custo" });
      }

      db.run(
        `UPDATE produtos SET
          nome = ?, tipo_produto = ?, categoria_id = ?, preco_venda = ?, preco_custo = ?, stock = ?, stock_minimo = ?,
          unidade_medida = ?, qtd_por_caixa = ?, preco_compra_caixa = ?, preco_venda_caixa = ?,
          tamanho = ?, marca = ?, descricao = ?, codigo_barras = ?
        WHERE id = ? AND empresa_id = ?`,
        [
          nome,
          tipo_produto,
          categoria_id,
          preco_venda,
          preco_custo,
          stock,
          stock_minimo,
          unidade_medida,
          qtd_por_caixa,
          preco_compra_caixa,
          preco_venda_caixa,
          tamanho,
          marca,
          descricao,
          codigo_barras,
          id,
          req.empresaId,
        ],
        function (updErr) {
          if (updErr) return res.status(500).json({ message: "Erro ao atualizar produto" });
          res.json({ message: "Produto atualizado com sucesso" });
        }
      );
    };

    if (body.categoria_id != null) {
      resolveCategoriaId(body.categoria_id, req.empresaId, (catErr, catId) => {
        if (catErr) return res.status(500).json({ message: "Erro ao resolver categoria" });
        applyUpdate(catId);
      });
    } else {
      applyUpdate(null);
    }
  });
});

app.delete("/api/produtos/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE produtos SET ativo = 0 WHERE id = ? AND empresa_id = ?",
    [id, req.empresaId],
    function (err) {
      if (err) return res.status(500).json({ message: "Erro ao remover produto" });
      if (this.changes === 0) return res.status(404).json({ message: "Produto não encontrado" });
      res.json({ message: "Produto removido com sucesso" });
    }
  );
});

// ===== MOVIMENTAÇÕES DE STOCK =====
app.post("/api/movimentacoes", verifyToken, (req, res) => {
  const { produto_id, quantidade, tipo, descricao, observacao } = req.body;
  const qty = Math.abs(Number(quantidade) || 0);
  if (!produto_id || qty <= 0) {
    return res.status(400).json({ message: "Produto e quantidade são obrigatórios" });
  }

  const tipoNorm = String(tipo || "entrada").toLowerCase();
  const desc = descricao || observacao || `Movimento: ${tipoNorm}`;

  db.get("SELECT stock FROM produtos WHERE id = ? AND empresa_id = ? AND ativo = 1", [produto_id, req.empresaId], (err, produto) => {
    if (err || !produto) return res.status(404).json({ message: "Produto não encontrado" });

    let delta = qty;
    if (tipoNorm === "saida" || tipoNorm === "venda") delta = -qty;
    if (tipoNorm === "entrada") delta = qty;

    const novoStock = produto.stock + delta;
    if (novoStock < 0) {
      return res.status(400).json({ message: "Stock insuficiente para esta operação" });
    }

    db.run(
      "INSERT INTO movimentacoes_stock (produto_id, empresa_id, tipo, quantidade, usuario_id, descricao) VALUES (?, ?, ?, ?, ?, ?)",
      [produto_id, req.empresaId, tipoNorm, qty, req.userId, desc],
      function (movErr) {
        if (movErr) return res.status(500).json({ message: "Erro ao registar movimento" });
        const movId = this.lastID;
        db.run("UPDATE produtos SET stock = ? WHERE id = ?", [novoStock, produto_id], (updErr) => {
          if (updErr) return res.status(500).json({ message: "Erro ao atualizar stock" });
          res.json({ id: movId, stock: novoStock, message: "Movimento registado com sucesso" });
        });
      }
    );
  });
});

app.get("/api/movimentacoes", verifyToken, (req, res) => {
  db.all(
    `SELECT m.*, p.nome AS produto_nome, p.preco_custo AS produto_preco_custo,
            u.nome AS usuario_nome
     FROM movimentacoes_stock m
     LEFT JOIN produtos p ON m.produto_id = p.id
     LEFT JOIN usuarios u ON m.usuario_id = u.id
     WHERE m.empresa_id = ?
     ORDER BY m.criado_em DESC
     LIMIT 500`,
    [req.empresaId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Erro ao buscar movimentos" });
      res.json(rows);
    }
  );
});

// ===== ROTAS DE CAIXA =====
app.get("/api/caixas/atual", verifyToken, (req, res) => {
  db.get(
    `SELECT c.*, u.nome as operador_abertura 
     FROM caixas c 
     LEFT JOIN usuarios u ON c.usuario_abertura_id = u.id
     WHERE c.empresa_id = ? AND c.status = 'aberto' 
     ORDER BY c.aberto_em DESC LIMIT 1`,
    [req.empresaId],
    (err, row) => {
      if (err) return res.status(500).json({ message: "Erro ao buscar caixa" });
      res.json(row || null);
    }
  );
});

app.post("/api/caixas/abrir", verifyToken, (req, res) => {
  const { valor_inicial } = req.body;
  
  // 1. Verificar se já existe um caixa ABERTO
  db.get(
    "SELECT id FROM caixas WHERE empresa_id = ? AND status = 'aberto'",
    [req.empresaId],
    (err, row) => {
      if (row) return res.status(400).json({ message: "Já existe um caixa aberto para esta empresa. Feche-o antes de abrir um novo." });

      db.run(
        `INSERT INTO caixas (empresa_id, usuario_abertura_id, valor_inicial, status, aberto_em) 
         VALUES (?, ?, ?, 'aberto', datetime('now', 'localtime'))`,
        [req.empresaId, req.userId, Number(valor_inicial) || 0],
        function (insErr) {
          if (insErr) return res.status(500).json({ message: "Erro ao abrir caixa" });
          res.json({ id: this.lastID, message: "Caixa aberto com sucesso" });
        }
      );
    }
  );
});

app.post("/api/caixas/reabrir", verifyToken, (req, res) => {
  const { id } = req.body;
  
  db.get("SELECT * FROM caixas WHERE id = ? AND empresa_id = ?", [id, req.empresaId], (err, caixa) => {
    if (err || !caixa) return res.status(404).json({ message: "Caixa não encontrado" });
    if (caixa.status === 'aberto') return res.status(400).json({ message: "O caixa já está aberto" });

    // Validar janela de 4 horas usando a hora do servidor para consistência
    const fechadoEm = new Date(caixa.fechado_em).getTime();
    const agora = new Date().getTime();
    const milissegundosPassados = agora - fechadoEm;
    const horasPassadas = milissegundosPassados / (1000 * 60 * 60);

    if (horasPassadas > 4) {
      return res.status(403).json({ message: "A janela de 4 horas para reabertura expirou." });
    }

    db.run(
      "UPDATE caixas SET status = 'aberto', fechado_em = NULL, usuario_fechamento_id = NULL WHERE id = ?",
      [id],
      (updErr) => {
        if (updErr) return res.status(500).json({ message: "Erro ao reabrir caixa" });
        res.json({ message: "Caixa reaberto com sucesso" });
      }
    );
  });
});

app.post("/api/caixas/fechar", verifyToken, (req, res) => {
  const { id, valor_fechamento, observacoes } = req.body;

  db.get("SELECT * FROM caixas WHERE id = ? AND empresa_id = ?", [id, req.empresaId], (err, caixa) => {
    if (err || !caixa) return res.status(404).json({ message: "Caixa não encontrado" });
    if (caixa.status === "fechado") return res.status(400).json({ message: "Este caixa já foi fechado" });

    // Calcular total de vendas vinculadas
    db.get(
      "SELECT SUM(total) as totalVendido FROM vendas WHERE caixa_id = ? AND empresa_id = ?",
      [id, req.empresaId],
      (vErr, result) => {
        const totalVendido = Number(result?.totalVendido || 0);
        const valorEsperado = Number(caixa.valor_inicial || 0) + totalVendido;
        const valorContado = Number(valor_fechamento || 0);
        const diferenca = valorContado - valorEsperado;

        db.run(
          `UPDATE caixas 
           SET status = 'fechado', valor_fechamento = ?, valor_esperado = ?, diferenca = ?, 
               usuario_fechamento_id = ?, fechado_em = datetime('now', 'localtime'), observacoes = ?
           WHERE id = ?`,
          [valorContado, valorEsperado, diferenca, req.userId, observacoes, id],
          (updErr) => {
            if (updErr) return res.status(500).json({ message: "Erro ao fechar caixa" });
            res.json({ message: "Caixa fechado com sucesso", totalVendido, valorEsperado, diferenca });
          }
        );
      }
    );
  });
});

app.get("/api/caixas/historico", verifyToken, (req, res) => {
  db.all(
    `SELECT c.*, u1.nome as operador_abertura, u2.nome as operador_fechamento
     FROM caixas c
     LEFT JOIN usuarios u1 ON c.usuario_abertura_id = u1.id
     LEFT JOIN usuarios u2 ON c.usuario_fechamento_id = u2.id
     WHERE c.empresa_id = ?
     ORDER BY c.aberto_em DESC
     LIMIT 100`,
    [req.empresaId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Erro ao buscar histórico de caixas" });
      res.json(rows);
    }
  );
});

// ===== ROTAS DE VENDAS =====
app.post("/api/vendas", verifyToken, (req, res) => {
  const {
    itens,
    total,
    metodo_pagamento = "dinheiro",
    status_pagamento = "pago",
    cliente_nome = "Cliente balcão",
    cliente_contacto = "",
    valor_recebido = 0,
    troco = 0,
    caixa_id
  } = req.body;

  if (!caixa_id) {
    return res.status(400).json({ message: "O caixa deve estar aberto para realizar vendas" });
  }

  if (!Array.isArray(itens) || !itens.length) {
    return res.status(400).json({ message: "Itens da venda são obrigatórios" });
  }

  const validarStock = (cb) => {
    let pending = itens.length;
    let erro = null;
    let custoTotal = 0;
    let totalCalculado = 0;

    itens.forEach((item) => {
      const qty = Number(item.quantidade) || 0;
      const pid = item.produto_id;
      const lineTotal = Number(item.total) || 0;
      if (qty <= 0) {
        erro = "Quantidade inválida na venda";
        pending--;
        if (pending === 0) cb(erro, custoTotal, totalCalculado);
        return;
      }
      if (lineTotal <= 0) {
        erro = "Total inválido na venda";
        pending--;
        if (pending === 0) cb(erro, custoTotal, totalCalculado);
        return;
      }
      db.get(
        "SELECT id, nome, stock, preco_custo FROM produtos WHERE id = ? AND empresa_id = ? AND ativo = 1",
        [pid, req.empresaId],
        (err, row) => {
          pending--;
          if (err || !row) erro = erro || "Produto não encontrado";
          else if (row.stock < qty) erro = `Stock insuficiente para ${row.nome}`;
          else {
            custoTotal += (Number(row.preco_custo) || 0) * qty;
            totalCalculado += lineTotal;
          }
          if (pending === 0) cb(erro, custoTotal, totalCalculado);
        }
      );
    });
  };

  validarStock((stockErr, custoTotal, totalCalculado) => {
    if (stockErr) return res.status(400).json({ message: stockErr });
    const vendaTotal = Number(totalCalculado || total || 0);
    if (vendaTotal <= 0) return res.status(400).json({ message: "Total da venda deve ser maior que zero" });
    
    // Removido bloqueio por margem negativa para permitir prejuízo real
    
    db.run(
      `INSERT INTO vendas (
        usuario_id, empresa_id, total, metodo_pagamento, status_pagamento,
        cliente_nome, cliente_contacto, valor_recebido, troco, caixa_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.userId,
        req.empresaId,
        vendaTotal,
        String(metodo_pagamento || "dinheiro"),
        String(status_pagamento || "pago"),
        String(cliente_nome || "Cliente balcão"),
        String(cliente_contacto || ""),
        Number(valor_recebido) || 0,
        Number(troco) || 0,
        caixa_id
      ],
      function (err) {
        if (err) return res.status(500).json({ message: "Erro ao registar venda" });

        const vendaId = this.lastID;

        itens.forEach((item) => {
          const qty = Number(item.quantidade) || 0;
          db.run(
            "INSERT INTO itens_venda (venda_id, produto_id, quantidade, preco_unitario, total) VALUES (?, ?, ?, ?, ?)",
            [vendaId, item.produto_id, qty, item.preco_unitario, item.total]
          );
          db.run("UPDATE produtos SET stock = stock - ? WHERE id = ? AND empresa_id = ?", [
            qty,
            item.produto_id,
            req.empresaId,
          ]);
          db.run(
            "INSERT INTO movimentacoes_stock (produto_id, empresa_id, tipo, quantidade, usuario_id, descricao) VALUES (?, ?, ?, ?, ?, ?)",
            [item.produto_id, req.empresaId, "venda", qty, req.userId, "Venda POS"]
          );
        });

        res.json({ id: vendaId, message: "Venda registada com sucesso" });

        // Registar automaticamente no financeiro
        db.run(
          `INSERT INTO transacoes_financeiras 
           (empresa_id, usuario_id, tipo, categoria, valor, metodo_pagamento, entidade_nome, observacao) 
           VALUES (?, ?, 'entrada', 'Venda', ?, ?, 'Cliente POS', ?)`,
          [req.empresaId, req.userId, vendaTotal, String(metodo_pagamento || "dinheiro"), `Venda ID: ${vendaId}`]
        );
      }
    );
  });
});

app.get("/api/vendas", verifyToken, (req, res) => {
  db.all(
    `SELECT v.*, u.nome AS vendedor,
            COALESCE(v.total - SUM(iv.quantidade * COALESCE(p.preco_custo, 0)), v.total) AS lucro
     FROM vendas v
     LEFT JOIN usuarios u ON v.usuario_id = u.id
     LEFT JOIN itens_venda iv ON iv.venda_id = v.id
     LEFT JOIN produtos p ON p.id = iv.produto_id
     WHERE v.empresa_id = ?
     GROUP BY v.id
     ORDER BY v.criado_em DESC
     LIMIT 300`,
    [req.empresaId],
    (err, vendas) => {
      if (err) {
        return res.status(500).json({ message: "Erro ao buscar vendas" });
      }
      
      if (!vendas || vendas.length === 0) {
        return res.json([]);
      }

      const vendaIds = vendas.map(v => v.id);
      db.all(
        `SELECT iv.*, p.nome as produto_nome 
         FROM itens_venda iv
         JOIN produtos p ON iv.produto_id = p.id
         WHERE iv.venda_id IN (${vendaIds.join(',')})`,
        [],
        (errItems, items) => {
          if (errItems) {
            console.error("Erro ao buscar itens das vendas:", errItems);
            return res.json(vendas);
          }

          const vendasComItens = vendas.map(v => ({
            ...v,
            produtos: items
              .filter(i => i.venda_id === v.id)
              .map(i => ({
                nome: i.produto_nome,
                qty: i.quantidade,
                preco: i.preco_unitario
              }))
          }));
          res.json(vendasComItens);
        }
      );
    }
  );
});

app.put("/api/vendas/:id/pagamento", verifyToken, (req, res) => {
  const { id } = req.params;
  const {
    metodo_pagamento = "dinheiro",
    status_pagamento = "pago",
    valor_recebido = 0,
    troco = 0,
  } = req.body;

  db.run(
    `UPDATE vendas
     SET metodo_pagamento = ?, status_pagamento = ?, valor_recebido = ?, troco = ?
     WHERE id = ? AND empresa_id = ?`,
    [
      String(metodo_pagamento || "dinheiro"),
      String(status_pagamento || "pago"),
      Number(valor_recebido) || 0,
      Number(troco) || 0,
      id,
      req.empresaId,
    ],
    function (err) {
      if (err) return res.status(500).json({ message: "Erro ao atualizar pagamento" });
      if (this.changes === 0) return res.status(404).json({ message: "Venda não encontrada" });
      res.json({ message: "Pagamento atualizado com sucesso" });
    }
  );
});

// ===== ROTAS DE RESERVAS =====
app.post("/api/reservas", verifyToken, (req, res) => {
  const { produto_id, quantidade, titular, bi } = req.body;
  if (!produto_id || !quantidade || !titular) {
    return res.status(400).json({ message: "Dados incompletos para reserva" });
  }

  db.serialize(() => {
    db.get("SELECT stock, nome FROM produtos WHERE id = ? AND empresa_id = ?", [produto_id, req.empresaId], (err, row) => {
      if (err || !row) return res.status(404).json({ message: "Produto não encontrado" });
      if (row.stock < quantidade) return res.status(400).json({ message: `Stock insuficiente para ${row.nome}` });

      db.run("BEGIN TRANSACTION");

      db.run(
        "INSERT INTO reservas (usuario_id, produto_id, empresa_id, quantidade, titular, bi, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [req.userId, produto_id, req.empresaId, quantidade, titular, bi, "Activa"],
        function (insErr) {
          if (insErr) {
            db.run("ROLLBACK");
            return res.status(500).json({ message: "Erro ao criar reserva" });
          }
          const resId = this.lastID;

          db.run("UPDATE produtos SET stock = stock - ? WHERE id = ?", [quantidade, produto_id], (updErr) => {
            if (updErr) {
              db.run("ROLLBACK");
              return res.status(500).json({ message: "Erro ao atualizar stock" });
            }
            
            db.run(
              "INSERT INTO movimentacoes_stock (produto_id, empresa_id, tipo, quantidade, usuario_id, descricao) VALUES (?, ?, ?, ?, ?, ?)",
              [produto_id, req.empresaId, "saida", quantidade, req.userId, `Reserva criada: ${titular}`],
              (movErr) => {
                if (movErr) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ message: "Erro ao registar movimento" });
                }
                db.run("COMMIT");
                res.json({ id: resId, message: "Reserva criada com sucesso" });
              }
            );
          });
        }
      );
    });
  });
});

app.get("/api/reservas", verifyToken, (req, res) => {
  db.all(
    `SELECT r.*, p.nome AS produto_nome, u.nome AS usuario_nome 
     FROM reservas r
     JOIN produtos p ON r.produto_id = p.id
     JOIN usuarios u ON r.usuario_id = u.id
     WHERE r.empresa_id = ?
     ORDER BY r.criado_em DESC`,
    [req.empresaId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Erro ao buscar reservas" });
      res.json(rows);
    }
  );
});

app.put("/api/reservas/:id/status", verifyToken, (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // "Activa", "Levantada", "Cancelada"

  db.get("SELECT * FROM reservas WHERE id = ? AND empresa_id = ?", [id, req.empresaId], (err, reserva) => {
    if (err || !reserva) return res.status(404).json({ message: "Reserva não encontrada" });

    if (status === "Cancelada" && reserva.status !== "Cancelada") {
      // Devolver stock se cancelar
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run("UPDATE reservas SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?", [status, id]);
        db.run("UPDATE produtos SET stock = stock + ? WHERE id = ?", [reserva.quantidade, reserva.produto_id]);
        db.run(
          "INSERT INTO movimentacoes_stock (produto_id, empresa_id, tipo, quantidade, usuario_id, descricao) VALUES (?, ?, ?, ?, ?, ?)",
          [reserva.produto_id, req.empresaId, "entrada", reserva.quantidade, req.userId, `Reserva cancelada: ${reserva.titular}`],
          (movErr) => {
            if (movErr) {
              db.run("ROLLBACK");
              return res.status(500).json({ message: "Erro ao cancelar reserva" });
            }
            db.run("COMMIT");
            res.json({ message: "Reserva cancelada e stock devolvido" });
          }
        );
      });
    } else {
      db.run("UPDATE reservas SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?", [status, id], (updErr) => {
        if (updErr) return res.status(500).json({ message: "Erro ao atualizar status" });
        res.json({ message: "Status da reserva atualizado" });
      });
    }
  });
});

// ===== ROTAS DE EMPRESA (CONFIGURAÇÕES) =====
app.get("/api/empresa", verifyToken, (req, res) => {
  db.get("SELECT * FROM empresas WHERE id = ?", [req.empresaId], (err, row) => {
    if (err || !row) return res.status(404).json({ message: "Empresa não encontrada" });
    res.json(row);
  });
});

app.put("/api/empresa", verifyToken, (req, res) => {
  const { nome, cnpj, endereco, telefone, email, background_image } = req.body;
  if (!nome) return res.status(400).json({ message: "Nome da empresa é obrigatório" });

  db.run(
    "UPDATE empresas SET nome = ?, cnpj = ?, endereco = ?, telefone = ?, email = ?, background_image = ? WHERE id = ?",
    [nome, cnpj, endereco, telefone, email, background_image, req.empresaId],
    function (err) {
      if (err) return res.status(500).json({ message: "Erro ao atualizar empresa" });
      res.json({ message: "Dados da empresa atualizados com sucesso" });
    }
  );
});

// Alterar senha do próprio usuário
app.put("/api/usuarios/me/senha", verifyToken, (req, res) => {
  const { senhaAtual, novaSenha } = req.body;
  if (!senhaAtual || !novaSenha) return res.status(400).json({ message: "Informe a senha atual e a nova senha" });

  db.get("SELECT senha FROM usuarios WHERE id = ?", [req.userId], (err, user) => {
    if (err || !user) return res.status(404).json({ message: "Usuário não encontrado" });

    const valid = bcrypt.compareSync(senhaAtual, user.senha);
    if (!valid) return res.status(401).json({ message: "Senha atual incorreta" });

    const hashed = bcrypt.hashSync(novaSenha, 10);
    db.run("UPDATE usuarios SET senha = ? WHERE id = ?", [hashed, req.userId], (updErr) => {
      if (updErr) return res.status(500).json({ message: "Erro ao atualizar senha" });
      res.json({ message: "Senha atualizada com sucesso" });
    });
  });
});

// ===== ROTAS FINANCEIRAS =====
app.get("/api/financeiro", verifyToken, (req, res) => {
  db.all(
    `SELECT t.*, u.nome as usuario_nome 
     FROM transacoes_financeiras t
     LEFT JOIN usuarios u ON t.usuario_id = u.id
     WHERE t.empresa_id = ? 
     ORDER BY t.data DESC LIMIT 500`,
    [req.empresaId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Erro ao buscar histórico financeiro" });
      res.json(rows);
    }
  );
});

app.post("/api/financeiro", verifyToken, (req, res) => {
  const { tipo, categoria, valor, metodo_pagamento, entidade_nome, observacao, data } = req.body;
  
  if (!tipo || !valor || !categoria) {
    return res.status(400).json({ message: "Tipo, valor e categoria são obrigatórios" });
  }

  db.run(
    `INSERT INTO transacoes_financeiras 
     (empresa_id, usuario_id, tipo, categoria, valor, metodo_pagamento, entidade_nome, observacao, data) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    [req.empresaId, req.userId, tipo, categoria, Number(valor), metodo_pagamento, entidade_nome, observacao, data],
    function(err) {
      if (err) return res.status(500).json({ message: "Erro ao registar transação financeira" });
      res.json({ id: this.lastID, message: "Transação registada com sucesso" });
    }
  );
});

// ===== ROTAS DE DASHBOARD =====
app.get("/api/dashboard/stats", verifyToken, (req, res) => {
  const empresaId = req.empresaId;

  db.all(
    `
    SELECT 
      (SELECT COUNT(*) FROM produtos WHERE empresa_id = ?) as totalProdutos,
      (SELECT COUNT(*) FROM vendas WHERE empresa_id = ?) as totalVendas,
      (SELECT SUM(total) FROM vendas WHERE empresa_id = ?) as totalVendido
  `,
    [empresaId, empresaId, empresaId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ message: "Erro ao buscar estatísticas" });
      }
      res.json(rows[0]);
    }
  );
});

// ===== ROTAS SUPER ADMIN (STATS) =====
app.get("/api/super/stats", verifyToken, (req, res) => {
  if (req.role !== "super") return res.status(403).json({ message: "Acesso negado" });

  db.get(
    `
    SELECT 
      (SELECT COUNT(*) FROM empresas) as totalEmpresas,
      (SELECT COUNT(*) FROM empresas WHERE ativo = 1) as activeEmpresas,
      (SELECT COUNT(*) FROM usuarios) as totalUsuarios,
      (SELECT COUNT(*) FROM produtos) as totalProdutos,
      (SELECT SUM(total) FROM vendas) as totalVendasGlobal
  `,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ message: "Erro ao buscar estatísticas globais" });
      res.json(row);
    }
  );
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ===== ROTAS SUPER ADMIN (EMPRESAS) =====
app.get("/api/super/empresas", verifyToken, (req, res) => {
  if (req.role !== "super") return res.status(403).json({ message: "Acesso negado" });
  db.all("SELECT e.*, (SELECT COUNT(*) FROM usuarios WHERE empresa_id = e.id) as vendedores FROM empresas e ORDER BY e.nome", [], (err, rows) => {
    if (err) return res.status(500).json({ message: "Erro ao buscar empresas" });
    res.json(rows);
  });
});

app.post("/api/super/empresas", verifyToken, (req, res) => {
  if (req.role !== "super") return res.status(403).json({ message: "Acesso negado" });
  const { nome, plano, data_expiracao, ativo } = req.body;
  if (!nome) return res.status(400).json({ message: "Nome é obrigatório" });
  
  db.run("INSERT INTO empresas (nome, plano, data_expiracao, ativo) VALUES (?, ?, ?, ?)", 
    [nome, plano || "Mensal", data_expiracao || null, ativo ?? 1], 
    function(err) {
      if (err) return res.status(500).json({ message: "Erro ao criar empresa" });
      res.json({ id: this.lastID, message: "Empresa criada com sucesso" });
    }
  );
});

// Helper para gerar chave de licença
function generateLicenseKey() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let key = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += "-";
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

app.post("/api/super/empresas/completo", verifyToken, async (req, res) => {
  if (req.role !== "super") return res.status(403).json({ message: "Acesso negado" });

  const { nomeEmpresa, bi, nomeEmpresario, email, senha, plano, dataExpiracao } = req.body;

  if (!nomeEmpresa || !email || !senha) {
    return res.status(400).json({ message: "Dados obrigatórios ausentes" });
  }

  // 1. Criar Empresa localmente
  db.run(
    "INSERT INTO empresas (nome, bi, empresario_nome, email, plano, data_expiracao, ativo) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [nomeEmpresa, bi, nomeEmpresario, email, plano || "Mensal", dataExpiracao || null, 1],
    async function (err) {
      if (err) {
        console.error("Erro ao criar empresa:", err.message);
        return res.status(500).json({ message: "Erro ao criar empresa local" });
      }

      const empresaId = this.lastID;

      // 2. Criar Gestor localmente
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(senha, salt);

      db.run(
        "INSERT INTO usuarios (nome, email, senha, role, empresa_id, ativo) VALUES (?, ?, ?, ?, ?, ?)",
        [nomeEmpresario, email, hash, 'gestor', empresaId, 1],
        async function (userErr) {
          if (userErr) {
            console.error("Erro ao criar gestor:", userErr.message);
            return res.status(500).json({ message: "Erro ao criar gestor local" });
          }

          // 3. Criar Licença no Supabase (se aplicável)
          let licenseKey = "";
          if (process.env.IS_LICENSING_SERVER && supabase) {
            licenseKey = generateLicenseKey();
            const expiresAt = dataExpiracao ? new Date(dataExpiracao) : new Date();
            if (!dataExpiracao) {
              if (plano === "Anual") expiresAt.setFullYear(expiresAt.getFullYear() + 1);
              else expiresAt.setMonth(expiresAt.getMonth() + 1);
            }

            try {
              const { error } = await supabase.from("licenses").insert({
                license_key: licenseKey,
                company_name: nomeEmpresa,
                plan: plano === "Anual" ? "yearly" : "monthly",
                status: "pending",
                expires_at: expiresAt.toISOString()
              });

              if (error) throw error;
              console.log(`[SUPER] Licença criada no Supabase: ${licenseKey}`);
            } catch (supaErr) {
              console.error("Erro ao criar licença no Supabase:", supaErr.message);
            }
          }

          res.json({
            message: "Empresa, Gestor e Licença criados com sucesso!",
            empresaId,
            licenseKey: licenseKey || "Offline-Mode"
          });
        }
      );
    }
  );
});

app.put("/api/super/empresas/:id", verifyToken, (req, res) => {
  if (req.role !== "super") return res.status(403).json({ message: "Acesso negado" });
  const { id } = req.params;
  const { nome, plano, data_expiracao, ativo } = req.body;
  
  db.run("UPDATE empresas SET nome = COALESCE(?, nome), plano = COALESCE(?, plano), data_expiracao = COALESCE(?, data_expiracao), ativo = COALESCE(?, ativo) WHERE id = ?",
    [nome, plano, data_expiracao, ativo, id],
    function(err) {
      if (err) return res.status(500).json({ message: "Erro ao atualizar empresa" });
      res.json({ message: "Empresa atualizada com sucesso" });
    }
  );
});

// ===== ROTAS DE USUÁRIOS =====
app.get("/api/usuarios", verifyToken, (req, res) => {
  if (req.role !== "super" && req.role !== "gestor") return res.status(403).json({ message: "Acesso negado" });
  
  let query = "SELECT id, nome, email, role, empresa_id, ativo, criado_em, permissoes FROM usuarios WHERE empresa_id = ?";
  let params = [req.empresaId];
  
  if (req.role === "super") {
    query = "SELECT id, nome, email, role, empresa_id, ativo, criado_em, permissoes FROM usuarios";
    params = [];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ message: "Erro ao buscar utilizadores" });
    res.json(rows.map(u => ({ ...u, permissoes: u.permissoes ? JSON.parse(u.permissoes) : [] })));
  });
});

app.post("/api/usuarios", verifyToken, (req, res) => {
  if (req.role !== "super" && req.role !== "gestor") return res.status(403).json({ message: "Acesso negado" });
  const { nome, email, senha, role, empresa_id, permissoes } = req.body;
  
  if (!nome || !email || !senha) return res.status(400).json({ message: "Nome, email e senha são obrigatórios" });
  
  const targetEmpresaId = req.role === "super" ? (empresa_id || req.empresaId) : req.empresaId;
  const targetRole = req.role === "gestor" ? "vendedor" : (role || "vendedor");
  const hashed = bcrypt.hashSync(senha, 10);
  const perms = Array.isArray(permissoes) ? JSON.stringify(permissoes) : "[]";

  db.run("INSERT INTO usuarios (nome, email, senha, role, empresa_id, permissoes) VALUES (?, ?, ?, ?, ?, ?)",
    [nome, email, hashed, targetRole, targetEmpresaId, perms],
    function(err) {
      if (err) return res.status(500).json({ message: "Erro ao criar utilizador: " + err.message });
      res.json({ id: this.lastID, message: "Utilizador criado com sucesso" });
    }
  );
});

app.put("/api/usuarios/:id", verifyToken, (req, res) => {
  if (req.role !== "super" && req.role !== "gestor") return res.status(403).json({ message: "Acesso negado" });
  const { id } = req.params;
  const { nome, email, role, ativo, permissoes } = req.body;

  // Gestor só edita usuários da sua empresa e não pode promover para super
  const checkQuery = req.role === "super" ? "SELECT id FROM usuarios WHERE id = ?" : "SELECT id FROM usuarios WHERE id = ? AND empresa_id = ?";
  const checkParams = req.role === "super" ? [id] : [id, req.empresaId];

  db.get(checkQuery, checkParams, (err, row) => {
    if (err || !row) return res.status(404).json({ message: "Utilizador não encontrado ou sem permissão" });
    
    const perms = Array.isArray(permissoes) ? JSON.stringify(permissoes) : undefined;
    const targetRole = req.role === "gestor" ? "vendedor" : role;

    db.run("UPDATE usuarios SET nome = COALESCE(?, nome), email = COALESCE(?, email), role = COALESCE(?, role), ativo = COALESCE(?, ativo), permissoes = COALESCE(?, permissoes) WHERE id = ?",
      [nome, email, targetRole, ativo, perms, id],
      function(updErr) {
        if (updErr) return res.status(500).json({ message: "Erro ao atualizar utilizador" });
        res.json({ message: "Utilizador atualizado com sucesso" });
      }
    );
  });
});

app.delete("/api/usuarios/:id", verifyToken, (req, res) => {
  if (req.role !== "super" && req.role !== "gestor") return res.status(403).json({ message: "Acesso negado" });
  const { id } = req.params;

  const checkQuery = req.role === "super" ? "SELECT id FROM usuarios WHERE id = ?" : "SELECT id FROM usuarios WHERE id = ? AND empresa_id = ?";
  const checkParams = req.role === "super" ? [id] : [id, req.empresaId];

  db.get(checkQuery, checkParams, (err, row) => {
    if (err || !row) return res.status(404).json({ message: "Utilizador não encontrado ou sem permissão" });
    
    db.run("DELETE FROM usuarios WHERE id = ?", [id], function(delErr) {
      if (delErr) return res.status(500).json({ message: "Erro ao remover utilizador" });
      res.json({ message: "Utilizador removido com sucesso" });
    });
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Iniciar servidor
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ Servidor backend rodando em http://127.0.0.1:${PORT}`);
});

// Tratamento de erros não capturados
process.on("uncaughtException", (err) => {
  console.error("Erro não capturado:", err);
});
