import type { SqlQuestionInput } from '@hireflow/contracts';

/**
 * The starter SQL questions Anvexa ships: 5 easy, 5 medium, 5 hard, on business data. HR adds them to the company's
 * bank from the SQL questions page (or `pnpm --filter @hireflow/api sql:seed`); they are then ordinary bank questions
 * in the database that HR can edit, deactivate or delete.
 *
 * Only the INPUT lives here (schema, datasets, reference query). Expected outputs are never written by hand: the API
 * runs every reference query on every dataset when the questions are added (tests/sql/starter-questions.test.ts
 * checks they all run). Each question has 2 sample datasets (shown to candidates, used by Run) and at least 3 hidden
 * ones that catch the usual mistakes: NULLs, ties, empty tables, a NOT IN that meets a NULL...
 */

type Cell = string | number | null;

/** INSERT statement for rows (strings quoted, '' escaped, null -> NULL). Empty rows -> no statement. */
export function insert(table: string, rows: Cell[][]): string {
  if (!rows.length) return '';
  const lit = (v: Cell) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);
  return `INSERT INTO ${table} VALUES\n${rows.map((r) => `  (${r.map(lit).join(', ')})`).join(',\n')};\n`;
}

// ------------------------------------------------------------------ employees (one table)

const EMPLOYEES = `CREATE TABLE employees (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  department TEXT,
  city       TEXT,
  salary     INTEGER
);`;

const emp = (rows: Cell[][]) => insert('employees', rows);

/** Sample 1: a small company (IT has 4 people). */
const E1 = emp([
  [1, 'Rahul', 'IT', 'Ahmedabad', 50000],
  [2, 'Priya', 'HR', 'Mumbai', 28000],
  [3, 'Amit', 'IT', 'Ahmedabad', 70000],
  [4, 'Neha', 'Sales', 'Pune', 45000],
  [5, 'Karan', 'IT', 'Surat', 30000],
  [6, 'Anjali', 'HR', 'Ahmedabad', 35000],
  [7, 'Dev', 'IT', 'Mumbai', 82000],
  [8, 'Isha', 'Sales', 'Ahmedabad', 30500],
]);
/** Sample 2: another company. */
const E2 = emp([
  [1, 'Sneha', 'Finance', 'Ahmedabad', 62000],
  [2, 'Vikram', 'Sales', 'Delhi', 31000],
  [3, 'Pooja', 'Finance', 'Mumbai', 58000],
  [4, 'Arjun', 'HR', 'Ahmedabad', 25000],
  [5, 'Meera', 'Sales', 'Ahmedabad', 40000],
  [6, 'Rohan', 'IT', 'Bengaluru', 90000],
  [7, 'Kavya', 'Sales', 'Pune', 29000],
]);
/** Hidden: bigger, ties at the top salary, several departments with 4 people. */
const E3 = emp([
  [1, 'Aarav', 'IT', 'Ahmedabad', 75000],
  [2, 'Diya', 'IT', 'Pune', 75000],
  [3, 'Kabir', 'Sales', 'Ahmedabad', 32000],
  [4, 'Riya', 'Sales', 'Mumbai', 30000],
  [5, 'Yash', 'Sales', 'Surat', 41000],
  [6, 'Tara', 'Sales', 'Ahmedabad', 30001],
  [7, 'Nikhil', 'HR', 'Delhi', 27000],
  [8, 'Sara', 'HR', 'Ahmedabad', 52000],
  [9, 'Om', 'Finance', 'Mumbai', 66000],
  [10, 'Zoya', 'Finance', 'Pune', 64000],
  [11, 'Manav', 'Finance', 'Ahmedabad', 70000],
  [12, 'Ira', 'Finance', 'Delhi', 66000],
  [13, 'Veer', 'IT', 'Mumbai', 98000],
  [14, 'Leela', 'IT', 'Bengaluru', 61000],
]);
/** Hidden: NULLs everywhere (no department, no city, no salary) and a lower-case city. */
const E4 = emp([
  [1, 'Ankit', 'IT', null, 30000],
  [2, 'Bhavna', null, 'Ahmedabad', 30000],
  [3, 'Chirag', 'Sales', 'ahmedabad', 45000],
  [4, 'Dhruv', 'Sales', 'Ahmedabad', null],
  [5, 'Farhan', 'IT', 'Vadodara', 30000],
]);
/** Hidden: everybody earns the same. */
const E5 = emp([
  [1, 'Gita', 'HR', 'Ahmedabad', 40000],
  [2, 'Hari', 'HR', 'Ahmedabad', 40000],
]);
/** Hidden: nobody yet. */
const E_EMPTY = '';

const employeeTests = (hidden: string[] = [E3, E4, E5]) => [
  { name: 'Sample company', dataSql: E1, hidden: false },
  { name: 'Second company', dataSql: E2, hidden: false },
  ...hidden.map((dataSql, i) => ({ name: `Hidden ${i + 1}`, dataSql, hidden: true })),
];

// ------------------------------------------------------------------ employees + departments

const EMP_DEPT = `CREATE TABLE departments (
  department_id   INTEGER PRIMARY KEY,
  department_name TEXT NOT NULL
);
CREATE TABLE employees (
  employee_id   INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  department_id INTEGER,
  salary        INTEGER
);`;

const deptData = (depts: Cell[][], emps: Cell[][]) => insert('departments', depts) + insert('employees', emps);

const D1 = deptData(
  [[101, 'IT'], [102, 'HR'], [103, 'Finance']],
  [[1, 'Rahul', 101, 50000], [2, 'Priya', 102, 60000], [3, 'Amit', 101, 70000], [4, 'Neha', 103, 45000], [5, 'Karan', 102, 80000]],
);
const D2 = deptData(
  [[201, 'Sales'], [202, 'Support']],
  [[1, 'Sneha', 201, 41000], [2, 'Vikram', 202, 33000], [3, 'Pooja', 201, 39000]],
);
/** Hidden: an employee without a department, a department nobody works in, and a department id that does not exist. */
const D3 = deptData(
  [[1, 'IT'], [2, 'HR'], [3, 'Legal']],
  [[1, 'Aarav', 1, 70000], [2, 'Diya', null, 52000], [3, 'Kabir', 2, 30000], [4, 'Riya', 999, 45000], [5, 'Yash', 1, 61000]],
);
/** Hidden: two departments with the same name. */
const D4 = deptData(
  [[10, 'Operations'], [11, 'Operations'], [12, 'Finance']],
  [[1, 'Om', 10, 55000], [2, 'Zoya', 11, 57000], [3, 'Manav', 12, 66000], [4, 'Ira', 12, 64000]],
);
/** Hidden: departments but no employees. */
const D5 = deptData([[1, 'IT']], []);

// ------------------------------------------------------------------ customers + orders

const SHOP = `CREATE TABLE customers (
  customer_id INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT
);
CREATE TABLE orders (
  order_id    INTEGER PRIMARY KEY,
  customer_id INTEGER,          -- NULL for a guest checkout
  order_date  TEXT    NOT NULL, -- 'YYYY-MM-DD'
  amount      REAL    NOT NULL
);`;

const shop = (customers: Cell[][], orders: Cell[][]) => insert('customers', customers) + insert('orders', orders);

const C1 = shop(
  [[1, 'Asha', 'Ahmedabad'], [2, 'Bharat', 'Mumbai'], [3, 'Chetna', 'Pune'], [4, 'Deepak', 'Surat']],
  [
    [1, 1, '2024-01-05', 1200.5],
    [2, 1, '2024-01-20', 800],
    [3, 2, '2024-02-02', 1500],
    [4, 3, '2024-02-14', 300.25],
    [5, 1, '2024-03-01', 999.99],
  ],
);
const C2 = shop(
  [[1, 'Esha', 'Delhi'], [2, 'Farhan', 'Delhi'], [3, 'Gaurav', 'Jaipur']],
  [
    [1, 2, '2023-12-30', 450],
    [2, 2, '2024-01-02', 550],
    [3, 3, '2024-01-15', 2000],
  ],
);
/** Hidden: a guest order (customer_id NULL) - NOT IN (SELECT customer_id ...) then returns nothing. */
const C3 = shop(
  [[1, 'Hema', 'Ahmedabad'], [2, 'Ishaan', 'Rajkot'], [3, 'Jaya', 'Ahmedabad']],
  [
    [1, 1, '2024-04-10', 700],
    [2, null, '2024-04-11', 150],
    [3, 1, '2024-05-02', 300],
  ],
);
/** Hidden: two customers with the same name, orders spread over a year boundary. */
const C4 = shop(
  [[1, 'Kiran', 'Pune'], [2, 'Kiran', 'Nagpur'], [3, 'Lata', 'Pune'], [4, 'Mohan', 'Goa']],
  [
    [1, 1, '2023-11-28', 100],
    [2, 2, '2023-12-01', 250.5],
    [3, 2, '2023-12-31', 49.5],
    [4, 3, '2024-01-01', 1000],
    [5, 3, '2024-01-31', 1000],
  ],
);
/** Hidden: customers, no orders at all. */
const C5 = shop([[1, 'Nisha', 'Surat'], [2, 'Omkar', 'Surat']], []);

const shopTests = [
  { name: 'Sample shop', dataSql: C1, hidden: false },
  { name: 'Second shop', dataSql: C2, hidden: false },
  { name: 'Hidden 1', dataSql: C3, hidden: true },
  { name: 'Hidden 2', dataSql: C4, hidden: true },
  { name: 'Hidden 3', dataSql: C5, hidden: true },
];

// ------------------------------------------------------------------ products + sales

const STORE = `CREATE TABLE products (
  product_id   INTEGER PRIMARY KEY,
  product_name TEXT NOT NULL,
  category     TEXT NOT NULL
);
CREATE TABLE sales (
  sale_id    INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(product_id),
  quantity   INTEGER NOT NULL,
  sale_date  TEXT    NOT NULL
);`;

const store = (products: Cell[][], sales: Cell[][]) => insert('products', products) + insert('sales', sales);

const P1 = store(
  [[1, 'Laptop', 'Electronics'], [2, 'Phone', 'Electronics'], [3, 'Desk', 'Furniture'], [4, 'Chair', 'Furniture']],
  [[1, 1, 3, '2024-01-02'], [2, 2, 5, '2024-01-03'], [3, 1, 4, '2024-01-09'], [4, 3, 2, '2024-01-10'], [5, 4, 6, '2024-01-11']],
);
const P2 = store(
  [[1, 'Pen', 'Stationery'], [2, 'Notebook', 'Stationery'], [3, 'Kettle', 'Kitchen']],
  [[1, 1, 10, '2024-02-01'], [2, 2, 12, '2024-02-01'], [3, 3, 1, '2024-02-02']],
);
/** Hidden: a tie for the top of a category (both are listed). */
const P3 = store(
  [[1, 'Tea', 'Grocery'], [2, 'Coffee', 'Grocery'], [3, 'Rice', 'Grocery'], [4, 'Soap', 'Personal care']],
  [[1, 1, 5, '2024-03-01'], [2, 2, 3, '2024-03-01'], [3, 2, 2, '2024-03-02'], [4, 3, 1, '2024-03-03'], [5, 4, 7, '2024-03-04']],
);
/** Hidden: a product that never sold, and a category where nothing sold. */
const P4 = store(
  [[1, 'Bat', 'Sports'], [2, 'Ball', 'Sports'], [3, 'Novel', 'Books'], [4, 'Atlas', 'Books'], [5, 'Lamp', 'Home']],
  [[1, 2, 4, '2024-04-01'], [2, 3, 1, '2024-04-02'], [3, 4, 3, '2024-04-03'], [4, 3, 1, '2024-04-05']],
);
/** Hidden: many small sales that only win when added up. */
const P5 = store(
  [[1, 'Milk', 'Dairy'], [2, 'Cheese', 'Dairy'], [3, 'Butter', 'Dairy']],
  [[1, 1, 1, '2024-05-01'], [2, 1, 1, '2024-05-02'], [3, 1, 1, '2024-05-03'], [4, 1, 1, '2024-05-04'], [5, 2, 3, '2024-05-01'], [6, 3, 2, '2024-05-02']],
);

const storeTests = [
  { name: 'Sample store', dataSql: P1, hidden: false },
  { name: 'Second store', dataSql: P2, hidden: false },
  { name: 'Hidden 1', dataSql: P3, hidden: true },
  { name: 'Hidden 2', dataSql: P4, hidden: true },
  { name: 'Hidden 3', dataSql: P5, hidden: true },
];

const deptTests = [
  { name: 'Sample company', dataSql: D1, hidden: false },
  { name: 'Second company', dataSql: D2, hidden: false },
  { name: 'Hidden 1', dataSql: D3, hidden: true },
  { name: 'Hidden 2', dataSql: D4, hidden: true },
  { name: 'Hidden 3', dataSql: D5, hidden: true },
];

export interface StarterSqlQuestion extends SqlQuestionInput {
  seedKey: string;
}

const q = (n: number, question: Omit<StarterSqlQuestion, 'seedKey'>): StarterSqlQuestion => ({ seedKey: `starter:${String(n).padStart(2, '0')}`, ...question });

export const STARTER_SQL_QUESTIONS: StarterSqlQuestion[] = [
  // ----------------------------------------------------------------- easy
  q(1, {
    title: 'Employees earning more than 30,000',
    description: 'List the id, name and salary of every employee whose salary is more than 30000. Columns: id, name, salary. Any row order.',
    difficulty: 'EASY',
    marks: 5,
    topics: ['SELECT', 'WHERE'],
    schemaSql: EMPLOYEES,
    referenceQuery: 'SELECT id, name, salary\nFROM employees\nWHERE salary > 30000;',
    tests: employeeTests([E3, E4, E_EMPTY]),
  }),
  q(2, {
    title: 'Employees from Ahmedabad',
    description: "List the id and name of the employees whose city is exactly 'Ahmedabad'. Columns: id, name. Any row order.",
    difficulty: 'EASY',
    marks: 5,
    topics: ['SELECT', 'WHERE'],
    schemaSql: EMPLOYEES,
    referenceQuery: "SELECT id, name\nFROM employees\nWHERE city = 'Ahmedabad';",
    tests: employeeTests(),
  }),
  q(3, {
    title: 'Employees by salary',
    description:
      'List the name and salary of every employee, highest salary first. Employees with the same salary are listed by name (A to Z). Employees without a salary come last. Columns: name, salary.',
    difficulty: 'EASY',
    marks: 5,
    topics: ['ORDER BY'],
    schemaSql: EMPLOYEES,
    referenceQuery: 'SELECT name, salary\nFROM employees\nORDER BY salary DESC, name ASC;',
    orderMatters: true,
    tests: employeeTests(),
  }),
  q(4, {
    title: 'Employees per department',
    description:
      'Show how many employees each department has. Employees without a department count as one group (department NULL). Columns: department, employee_count. Any row order.',
    difficulty: 'EASY',
    marks: 5,
    topics: ['GROUP BY', 'COUNT()'],
    schemaSql: EMPLOYEES,
    referenceQuery: 'SELECT department, COUNT(*) AS employee_count\nFROM employees\nGROUP BY department;',
    tests: employeeTests([E3, E4, E_EMPTY]),
  }),
  q(5, {
    title: 'Highest salary',
    description: 'Return the highest salary in the company as a single value (NULL when there are no salaries). Column: max_salary.',
    difficulty: 'EASY',
    marks: 5,
    topics: ['MAX()'],
    schemaSql: EMPLOYEES,
    referenceQuery: 'SELECT MAX(salary) AS max_salary\nFROM employees;',
    tests: employeeTests([E3, E4, E_EMPTY]),
  }),

  // ----------------------------------------------------------------- medium
  q(6, {
    title: 'Average salary per department',
    description:
      'Show the average salary of each department (do not round it). Employees without a salary are ignored, as AVG does. Columns: department, average_salary. Any row order.',
    difficulty: 'MEDIUM',
    marks: 10,
    topics: ['GROUP BY', 'AVG()'],
    schemaSql: EMPLOYEES,
    referenceQuery: 'SELECT department, AVG(salary) AS average_salary\nFROM employees\nGROUP BY department;',
    tests: employeeTests(),
  }),
  q(7, {
    title: 'Departments with more than 3 employees',
    description: 'List the departments that have more than 3 employees, with their number of employees. Columns: department, employee_count. Any row order.',
    difficulty: 'MEDIUM',
    marks: 10,
    topics: ['GROUP BY', 'HAVING', 'COUNT()'],
    schemaSql: EMPLOYEES,
    referenceQuery: 'SELECT department, COUNT(*) AS employee_count\nFROM employees\nGROUP BY department\nHAVING COUNT(*) > 3;',
    tests: employeeTests([E3, E4, E5]),
  }),
  q(8, {
    title: 'Employees with their department',
    description:
      'List each employee with the name of their department. Employees whose department does not exist (or who have none) are left out. Columns: name, department_name. Any row order.',
    difficulty: 'MEDIUM',
    marks: 10,
    topics: ['INNER JOIN'],
    schemaSql: EMP_DEPT,
    referenceQuery: 'SELECT e.name, d.department_name\nFROM employees e\nJOIN departments d ON d.department_id = e.department_id;',
    tests: deptTests,
  }),
  q(9, {
    title: 'Orders per customer',
    description:
      'List every customer with the number of orders they placed. Customers who never ordered must appear with 0. Columns: customer_id, name, order_count. Any row order.',
    difficulty: 'MEDIUM',
    marks: 10,
    topics: ['LEFT JOIN', 'GROUP BY', 'COUNT()'],
    schemaSql: SHOP,
    referenceQuery:
      'SELECT c.customer_id, c.name, COUNT(o.order_id) AS order_count\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.customer_id\nGROUP BY c.customer_id, c.name;',
    tests: shopTests,
  }),
  q(10, {
    title: 'Second-highest salary',
    description:
      'Return the second-highest DIFFERENT salary (if the top salary is shared, the next lower one). Return NULL when there is no second-highest salary. Column: second_highest_salary.',
    difficulty: 'MEDIUM',
    marks: 10,
    topics: ['Subqueries', 'MAX()', 'NULL handling'],
    schemaSql: EMPLOYEES,
    referenceQuery: 'SELECT MAX(salary) AS second_highest_salary\nFROM employees\nWHERE salary < (SELECT MAX(salary) FROM employees);',
    tests: employeeTests([E3, E4, E5]),
  }),

  // ----------------------------------------------------------------- hard
  q(11, {
    title: 'Third-highest salary',
    description:
      'Return the third-highest DIFFERENT salary using a subquery. Return NULL when there are fewer than three different salaries. Column: third_highest_salary.',
    difficulty: 'HARD',
    marks: 15,
    topics: ['Subqueries', 'DISTINCT', 'LIMIT', 'NULL handling'],
    schemaSql: EMPLOYEES,
    referenceQuery:
      'SELECT (\n  SELECT DISTINCT salary\n  FROM employees\n  WHERE salary IS NOT NULL\n  ORDER BY salary DESC\n  LIMIT 1 OFFSET 2\n) AS third_highest_salary;',
    tests: employeeTests([E3, E4, E5]),
  }),
  q(12, {
    title: 'Departments paid above the company average',
    description:
      "List the departments whose average salary is greater than the whole company's average salary, with that department average (not rounded). Columns: department, average_salary. Any row order.",
    difficulty: 'HARD',
    marks: 15,
    topics: ['GROUP BY', 'HAVING', 'AVG()', 'Subqueries'],
    schemaSql: EMPLOYEES,
    referenceQuery:
      'SELECT department, AVG(salary) AS average_salary\nFROM employees\nGROUP BY department\nHAVING AVG(salary) > (SELECT AVG(salary) FROM employees);',
    tests: employeeTests([E3, E4, E5]),
  }),
  q(13, {
    title: 'Customers who never ordered',
    description:
      'List the customers who have never placed an order. Careful: guest orders have no customer (customer_id is NULL). Columns: customer_id, name. Any row order.',
    difficulty: 'HARD',
    marks: 15,
    topics: ['LEFT JOIN', 'Subqueries', 'NULL handling'],
    schemaSql: SHOP,
    referenceQuery:
      'SELECT c.customer_id, c.name\nFROM customers c\nWHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id);',
    tests: shopTests,
  }),
  q(14, {
    title: 'Best-selling product of each category',
    description:
      'For each category, find the product with the highest total quantity sold (all its sales added up). If several products tie for the top of a category, list all of them. Products that never sold are ignored. Columns: category, product_name, total_quantity. Any row order.',
    difficulty: 'HARD',
    marks: 15,
    topics: ['JOIN', 'GROUP BY', 'SUM()', 'Subqueries'],
    schemaSql: STORE,
    referenceQuery: `WITH totals AS (
  SELECT p.category, p.product_name, SUM(s.quantity) AS total_quantity
  FROM products p
  JOIN sales s ON s.product_id = p.product_id
  GROUP BY p.product_id
)
SELECT category, product_name, total_quantity
FROM totals t
WHERE total_quantity = (SELECT MAX(total_quantity) FROM totals t2 WHERE t2.category = t.category);`,
    tests: storeTests,
  }),
  q(15, {
    title: 'Monthly revenue',
    description:
      "Show the total order amount of each month that has orders, oldest month first. order_date is text 'YYYY-MM-DD'; in SQLite strftime('%Y-%m', order_date) gives the month as 'YYYY-MM'. Columns: month, revenue.",
    difficulty: 'HARD',
    marks: 15,
    topics: ['GROUP BY', 'SUM()', 'Date functions', 'ORDER BY'],
    schemaSql: SHOP,
    referenceQuery: "SELECT strftime('%Y-%m', order_date) AS month, SUM(amount) AS revenue\nFROM orders\nGROUP BY month\nORDER BY month;",
    orderMatters: true,
    tests: shopTests,
  }),
];
