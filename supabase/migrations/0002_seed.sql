-- Menú real de Pancho Esquites (precios en centavos)
insert into categories(name, sort) values
 ('Esquites',1),('Elotes',2),('Gorditas',3),('Antojitos',4),('Panqué',5),('Salsa',6),('Bebidas',7);

insert into products(category_id, name, short_name, price_cents, sort)
select c.id, p.name, p.short, p.price*100, p.sort from (values
 ('Esquites','Esquite chico','Chico',35,1),('Esquites','Esquite mediano','Mediano',45,2),
 ('Esquites','Esquite grande','Grande',55,3),('Esquites','Esquite extragrande','Extragrande',120,4),
 ('Esquites','Rebanado por pieza','Rebanado por pieza',40,5),
 ('Esquites','Combinado asado/tradicional mediano','Combinado mediano',50,6),
 ('Esquites','Combinado asado/tradicional grande','Combinado grande',60,7),
 ('Esquites','Asado grande','Asado grande',70,8),('Esquites','Vaso mediano extra','Vaso extra',5,9),
 ('Elotes','Elote asado','Asado',35,1),('Elotes','Elote hervido','Hervido',35,2),
 ('Gorditas','Gordita de migajas','Migajas',18,1),('Gorditas','Gordita de queso','Queso',18,2),
 ('Gorditas','Gordita combinada','Combinada',20,3),
 ('Antojitos','Sabritas preparadas','Sabritas',30,1),('Antojitos','Papas naturales','Papas naturales',35,2),
 ('Antojitos','Papas adobadas','Papas adobadas',35,3),('Antojitos','Plátanos','Plátanos',35,4),
 ('Antojitos','Muéganos','Muéganos',15,5),
 ('Panqué','Panqué chico sin queso','Chico s/queso',18,1),('Panqué','Panqué chico con queso','Chico c/queso',19,2),
 ('Panqué','Panqué grande sin queso','Grande s/queso',140,3),('Panqué','Panqué grande con queso','Grande c/queso',150,4),
 ('Salsa','Salsa medio litro','Medio litro',50,1),('Salsa','Salsa litro','Litro',100,2),
 ('Bebidas','Agua de ½ litro','Agua ½ litro',30,1),('Bebidas','Agua de litro','Agua litro',45,2),
 ('Bebidas','Agua mineral','Agua mineral',30,3),('Bebidas','Coco con agua','Coco con agua',50,4),
 ('Bebidas','Agua natural','Agua natural',15,5),('Bebidas','Refresco de lata','Refresco lata',25,6),
 ('Bebidas','Refresco 600 ml','Refresco 600 ml',30,7)
) as p(cat,name,short,price,sort) join categories c on c.name = p.cat
order by c.sort, p.sort;

insert into inventory_items(id,name,unit,stock,min_stock) values
 ('elote','Elote desgranado','kg',0,8),('eloteE','Elotes enteros','pz',0,20),
 ('vch','Vasos chicos','pz',0,50),('vme','Vasos medianos','pz',0,50),('vgr','Vasos grandes','pz',0,40),
 ('vxg','Vasos extragrandes','pz',0,10),('queso','Queso','kg',0,2),('mayo','Mayonesa','kg',0,1.5),
 ('masa','Masa para gorditas','kg',0,3),('salsa','Salsa preparada','L',0,3),
 ('lata','Refresco de lata','pz',0,6),('r600','Refresco 600 ml','pz',0,6);

-- Recetas estimadas (ajustar con el dueño)
insert into recipes(product_id,item_id,qty)
select p.id, r.item, r.qty from (values
 ('Esquite chico','vch',1),('Esquite chico','elote',.25),('Esquite chico','queso',.02),('Esquite chico','mayo',.02),
 ('Esquite mediano','vme',1),('Esquite mediano','elote',.35),('Esquite mediano','queso',.03),('Esquite mediano','mayo',.03),
 ('Esquite grande','vgr',1),('Esquite grande','elote',.45),('Esquite grande','queso',.04),('Esquite grande','mayo',.04),
 ('Esquite extragrande','vxg',1),('Esquite extragrande','elote',1),
 ('Elote asado','eloteE',1),('Elote hervido','eloteE',1),
 ('Gordita de queso','masa',.08),('Gordita de migajas','masa',.08),('Gordita combinada','masa',.08),
 ('Salsa medio litro','salsa',.5),('Salsa litro','salsa',1),
 ('Refresco de lata','lata',1),('Refresco 600 ml','r600',1)
) as r(prod,item,qty) join products p on p.name = r.prod;
